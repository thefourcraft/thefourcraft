/*
  dfstats — self-hosted GitHub profile stat cards, served as SVG.
  Endpoints (all return image/svg+xml):
    GET /streak          GitHub streak card (total / current / longest)
    GET /stats           David's GitHub Stats card with letter grade
    GET /graph           David's contribution graph (last 30 days line chart)
    GET /health          plain-text ok
  All responses are cached in the CF edge cache for 6 hours.
*/

export interface Env {
  GH_USER: string;
  GH_TOKEN?: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────
// `statsitis` is consumed by the dfwebsite Worker via Astro API endpoints
// under /api/stats/*. The renderers are exported below for direct use; the
// Worker router is retained as the default export for standalone deploys
// and for local preview via `wrangler dev`.

export { renderStreak, renderStats, renderGraph, renderPulse };

const PUBLIC_TTL_S = 300; // 5 min — GitHub camo freezes images for as long as this
const CAMO_TTL_S = 120; // 2 min when the requester is GitHub's camo proxy
const EDGE_TTL_S = 604800; // 7d — Cache API keep-alive so origin stays fast
const FRESH_MS = 30 * 60 * 1000;

type RangeId = '7d' | '30d' | '1y';
type Range = { id: RangeId; days: number; label: string };

function parseRange(raw: string | null): Range {
  const v = (raw || '').toLowerCase();
  if (v === '30d' || v === '30') return { id: '30d', days: 30, label: 'Last 30 days' };
  if (v === '1y' || v === '365d' || v === 'year') return { id: '1y', days: 365, label: 'Last 12 months' };
  return { id: '7d', days: 7, label: 'Last 7 days' };
}

function publicMaxAge(req: Request): number {
  const ua = req.headers.get('user-agent') || '';
  return /camo/i.test(ua) ? CAMO_TTL_S : PUBLIC_TTL_S;
}

function withPublicCache(res: Response, req: Request): Response {
  const ttl = publicMaxAge(req);
  const headers = new Headers(res.headers);
  headers.set(
    'Cache-Control',
    `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=3600`,
  );
  headers.set('CDN-Cache-Control', `public, max-age=${ttl}`);
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Handle a stats request on a given pathname. Used by the website Worker to
 * delegate /api/stats/{streak,stats,graph} without reimplementing routing or
 * edge caching. Returns a fully-formed SVG response (or 404/500).
 *
 * Cache is served first so GitHub's camo proxy never waits on GraphQL.
 * A miss awaits cache.put (waitUntil is a no-op in some Astro adapters).
 * Stale entries older than 30 minutes refresh in the background.
 */
export async function handleStatsRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  pathname: string,
): Promise<Response> {
  const url = new URL(req.url);
  const user = (url.searchParams.get('user') || env.GH_USER || 'thefourcraft').trim();
  const range = parseRange(url.searchParams.get('range'));
  // Graph stays 30d on the profile unless ?range= is set. Pulse defaults to 7d.
  const graphRange = url.searchParams.has('range')
    ? range
    : ({ id: '30d', days: 30, label: 'Last 30 days' } satisfies Range);

  if (pathname === 'health') return text('ok');

  const cache = (caches as unknown as { default: Cache }).default;
  // Ignore cache-bust `v=` so camo busts don't fragment the origin cache.
  // Range IS part of the key — 7d vs 30d are different SVGs.
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set('user', user);
  cacheUrl.searchParams.set('g', '3');
  if (pathname === 'pulse') cacheUrl.searchParams.set('range', range.id);
  if (pathname === 'graph') cacheUrl.searchParams.set('range', graphRange.id);
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  let cached: Response | undefined;
  try {
    cached = await cache.match(cacheKey);
  } catch {
    cached = undefined;
  }

  if (cached) {
    const generated = Number(cached.headers.get('x-dfstats-generated') || '0');
    if (!generated || Date.now() - generated > FRESH_MS) {
      ctx.waitUntil(
        buildAndStore(cache, cacheKey, user, env, pathname, range, graphRange)
          .then(() => undefined)
          .catch(() => undefined),
      );
    }
    // Never forward the 7-day Cache API TTL to GitHub camo — that froze the profile.
    return withPublicCache(cached.clone(), req);
  }

  try {
    const built = await buildAndStore(cache, cacheKey, user, env, pathname, range, graphRange);
    return withPublicCache(built, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return svgResponse(errorCard(msg), 500, 60);
  }
}

async function buildAndStore(
  cache: Cache,
  cacheKey: Request,
  user: string,
  env: Env,
  pathname: string,
  range: Range,
  graphRange: Range,
): Promise<Response> {
  let body: Response;
  if (pathname === 'streak') body = await renderStreak(user, env);
  else if (pathname === 'stats') body = await renderStats(user, env);
  else if (pathname === 'graph') body = await renderGraph(user, env, graphRange.days);
  else if (pathname === 'pulse') body = await renderPulse(user, env, range);
  else return new Response('not found', { status: 404 });

  const headers = new Headers(body.headers);
  headers.set('x-dfstats-generated', String(Date.now()));
  const response = new Response(body.body, { status: body.status, headers });

  try {
    const stored = response.clone();
    stored.headers.set('Cache-Control', `public, max-age=${EDGE_TTL_S}`);
    await cache.put(cacheKey, stored);
  } catch {
    // Cache API unavailable — still return the live SVG.
  }
  return response;
}

// Standalone Worker entry (retained for `wrangler dev` inside statsitis/).
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const user = (url.searchParams.get('user') || env.GH_USER || 'thefourcraft').trim();
    const seg = url.pathname.replace(/^\/+/, '').split('/').pop() || '';
    if (url.pathname === '/' || url.pathname === '/index.html') return indexPage(user);
    return handleStatsRequest(req, env, ctx, seg);
  },
};

// ─── Response helpers ───────────────────────────────────────────────────────
function svgResponse(svg: string, status = 200, maxAge = PUBLIC_TTL_S): Response {
  return new Response(svg, {
    status,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    },
  });
}
function text(s: string): Response {
  return new Response(s, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ─── GitHub data fetchers ───────────────────────────────────────────────────
const UA = 'dfstats/1.0 (+https://david-furman.com)';

async function ghFetch(url: string, env: Env, extra: RequestInit = {}): Promise<Response> {
  const headers = new Headers(extra.headers as HeadersInit | undefined);
  headers.set('User-Agent', UA);
  headers.set('Accept', headers.get('Accept') || 'application/vnd.github+json');
  if (env.GH_TOKEN) headers.set('Authorization', `Bearer ${env.GH_TOKEN}`);
  return fetch(url, { ...extra, headers });
}

type Day = { date: string; count: number };

const MAX_YEAR_WINDOWS = 15;

function yearWindows(since: Date, today = new Date()): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(since);
  while (cursor <= today && windows.length < MAX_YEAR_WINDOWS) {
    const end = new Date(cursor);
    end.setFullYear(end.getFullYear() + 1);
    if (end > today) end.setTime(today.getTime());
    windows.push({ from: new Date(cursor), to: new Date(end) });
    const next = new Date(end);
    next.setDate(next.getDate() + 1);
    cursor = next;
  }
  return windows;
}

/** Fetch daily contribution counts via GraphQL. Requires GH_TOKEN; max 1-year window per call. */
async function fetchContributionDays(
  user: string,
  from: string,
  to: string,
  env: Env,
): Promise<Day[]> {
  if (!env.GH_TOKEN) {
    // Fallback: scrape the public HTML page (may be rate-limited from Worker IPs).
    return fetchContributionDaysHTML(user, from, to);
  }
  const query = `query($user:String!,$from:DateTime!,$to:DateTime!){
    user(login:$user){
      contributionsCollection(from:$from,to:$to){
        contributionCalendar{
          weeks{ contributionDays{ date contributionCount } }
        }
      }
    }
  }`;
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'User-Agent': UA,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { user, from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` },
    }),
  });
  if (!r.ok) throw new Error(`graphql ${r.status}`);
  const data = (await r.json()) as {
    data?: {
      user?: {
        contributionsCollection?: {
          contributionCalendar?: {
            weeks: Array<{ contributionDays: Array<{ date: string; contributionCount: number }> }>;
          };
        };
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) throw new Error('gql: ' + data.errors.map((e) => e.message).join('; '));
  const weeks = data.data?.user?.contributionsCollection?.contributionCalendar?.weeks ?? [];
  const out: Day[] = [];
  for (const w of weeks) {
    for (const d of w.contributionDays) out.push({ date: d.date, count: d.contributionCount });
  }
  return out;
}

/** Legacy HTML scrape fallback (used when no token is configured). */
async function fetchContributionDaysHTML(user: string, from: string, to: string): Promise<Day[]> {
  const r = await fetch(
    `https://github.com/users/${encodeURIComponent(user)}/contributions?from=${from}&to=${to}`,
    { headers: { 'User-Agent': UA, Accept: 'text/html' } },
  );
  if (!r.ok) throw new Error(`contributions ${r.status}`);
  const html = await r.text();
  const days: Day[] = [];
  const tdRe = /<td\b([^>]*class="ContributionCalendar-day"[^>]*)>/g;
  const attr = (s: string, name: string): string | null => {
    const re = new RegExp(`\\b${name}="([^"]+)"`);
    const m = re.exec(s);
    return m ? m[1] : null;
  };
  const tooltips = new Map<string, string>();
  const toolRe = /<tool-tip[^>]*\bfor="([^"]+)"[^>]*>([^<]+)<\/tool-tip>/g;
  let m: RegExpExecArray | null;
  while ((m = toolRe.exec(html))) tooltips.set(m[1], m[2]);
  while ((m = tdRe.exec(html))) {
    const attrs = m[1];
    const date = attr(attrs, 'data-date');
    const id = attr(attrs, 'id');
    if (!date || !id) continue;
    const tip = tooltips.get(id) || '';
    const cm = /^(\d+|No)\s+contribution/.exec(tip);
    const count = !cm ? 0 : cm[1] === 'No' ? 0 : parseInt(cm[1], 10);
    days.push({ date, count });
  }
  return days;
}

function dedupeDays(all: Day[]): Day[] {
  const byDate = new Map<string, number>();
  for (const d of all) byDate.set(d.date, d.count);
  return Array.from(byDate, ([date, count]) => ({ date, count })).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
}

/** Fetch all contribution days since user creation. One aliased GraphQL query. */
async function fetchAllContributions(user: string, since: Date, env: Env): Promise<Day[]> {
  const windows = yearWindows(since);
  if (!env.GH_TOKEN) {
    const all: Day[] = [];
    for (const w of windows) {
      all.push(
        ...(await fetchContributionDays(
          user,
          w.from.toISOString().slice(0, 10),
          w.to.toISOString().slice(0, 10),
          env,
        )),
      );
    }
    return dedupeDays(all);
  }

  const CHUNK = 1;
  const groups: Array<Array<{ from: Date; to: Date }>> = [];
  for (let i = 0; i < windows.length; i += CHUNK) groups.push(windows.slice(i, i + CHUNK));
  try {
    const parts = await Promise.all(groups.map((g) => fetchAllContributionsBatched(user, g, env)));
    return dedupeDays(parts.flat());
  } catch {
    const all: Day[] = [];
    for (const w of windows) {
      all.push(
        ...(await fetchContributionDays(
          user,
          w.from.toISOString().slice(0, 10),
          w.to.toISOString().slice(0, 10),
          env,
        )),
      );
    }
    return dedupeDays(all);
  }
}

async function fetchAllContributionsBatched(
  user: string,
  windows: Array<{ from: Date; to: Date }>,
  env: Env,
): Promise<Day[]> {
  const varDefs = ['$user:String!', ...windows.flatMap((_, i) => [`$from${i}:DateTime!`, `$to${i}:DateTime!`])].join(
    ',',
  );
  const selections = windows
    .map(
      (_, i) =>
        `y${i}: contributionsCollection(from:$from${i}, to:$to${i}) {
          contributionCalendar { weeks { contributionDays { date contributionCount } } }
        }`,
    )
    .join('\n');
  const variables: Record<string, unknown> = { user };
  windows.forEach((w, i) => {
    variables[`from${i}`] = w.from.toISOString().slice(0, 10) + 'T00:00:00Z';
    variables[`to${i}`] = w.to.toISOString().slice(0, 10) + 'T23:59:59Z';
  });

  const data = await ghGraphQL<{
    user: Record<
      string,
      {
        contributionCalendar?: {
          weeks: Array<{ contributionDays: Array<{ date: string; contributionCount: number }> }>;
        };
      }
    >;
  }>(env, `query(${varDefs}){ user(login:$user){ ${selections} } }`, variables);

  const all: Day[] = [];
  for (let i = 0; i < windows.length; i++) {
    const weeks = data.user?.[`y${i}`]?.contributionCalendar?.weeks ?? [];
    for (const w of weeks) {
      for (const d of w.contributionDays) all.push({ date: d.date, count: d.contributionCount });
    }
  }
  return dedupeDays(all);
}

async function fetchUserProfile(user: string, env: Env) {
  const r = await ghFetch(`https://api.github.com/users/${encodeURIComponent(user)}`, env);
  if (!r.ok) throw new Error(`user ${r.status}`);
  return (await r.json()) as {
    created_at: string;
    public_repos: number;
    followers: number;
    name: string | null;
    login: string;
  };
}

async function fetchTotalStars(user: string, env: Env): Promise<number> {
  let page = 1;
  let stars = 0;
  for (;;) {
    const r = await ghFetch(
      `https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&page=${page}&type=owner`,
      env,
    );
    if (!r.ok) throw new Error(`repos ${r.status}`);
    const repos = (await r.json()) as Array<{ stargazers_count: number; fork: boolean }>;
    for (const repo of repos) if (!repo.fork) stars += repo.stargazers_count;
    if (repos.length < 100) break;
    page += 1;
    if (page > 10) break;
  }
  return stars;
}

async function fetchSearchTotal(q: string, env: Env): Promise<number> {
  try {
    const r = await ghFetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=1`,
      env,
      { signal: AbortSignal.timeout(1500) },
    );
    if (!r.ok) return 0;
    const d = (await r.json()) as { total_count: number };
    return d.total_count;
  } catch {
    return 0;
  }
}

async function fetchCommitCount(user: string, env: Env): Promise<number> {
  const r = await ghFetch(
    `https://api.github.com/search/commits?q=${encodeURIComponent(`author:${user}`)}&per_page=1`,
    env,
    { headers: { Accept: 'application/vnd.github.cloak-preview+json' } },
  );
  if (!r.ok) return 0;
  const d = (await r.json()) as { total_count: number };
  return d.total_count;
}

// ─── GraphQL lifetime totals (includes private contribs when authed as self) ─
type LifetimeTotals = {
  commits: number;
  prs: number;
  prsMerged: number;
  prsReviewed: number;
  issues: number;
  reposContributed: number;
  lastYearContribs: number;
  lastYearReposContributed: number;
  discussionsStarted: number;
};

async function ghGraphQL<T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T> {
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN required');
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'User-Agent': UA,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`graphql ${r.status}`);
  const j = (await r.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (j.errors?.length) throw new Error('gql: ' + j.errors.map((e) => e.message).join('; '));
  return j.data as T;
}

type PulseTotals = {
  commits: number;
  prs: number;
  prsMerged: number;
  reviews: number;
  issues: number;
  contribs: number;
};

async function fetchPulse(user: string, range: Range, env: Env): Promise<PulseTotals> {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (range.days - 1));
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const fromDay = fromIso.slice(0, 10);

  const [gql, prsMerged] = await Promise.all([
    ghGraphQL<{
      user: {
        contributionsCollection: {
          totalCommitContributions: number;
          totalPullRequestContributions: number;
          totalPullRequestReviewContributions: number;
          totalIssueContributions: number;
          contributionCalendar: { totalContributions: number };
        };
      };
    }>(
      env,
      `query($user:String!,$from:DateTime!,$to:DateTime!){
        user(login:$user){
          contributionsCollection(from:$from,to:$to){
            totalCommitContributions
            totalPullRequestContributions
            totalPullRequestReviewContributions
            totalIssueContributions
            contributionCalendar{ totalContributions }
          }
        }
      }`,
      { user, from: fromIso, to: toIso },
    ),
    fetchSearchTotal(`author:${user} type:pr is:merged merged:>=${fromDay}`, env).catch(() => 0),
  ]);
  const c = gql.user.contributionsCollection;
  return {
    commits: c.totalCommitContributions,
    prs: c.totalPullRequestContributions,
    prsMerged,
    reviews: c.totalPullRequestReviewContributions,
    issues: c.totalIssueContributions,
    contribs: c.contributionCalendar.totalContributions,
  };
}

type YearTotals = {
  totalCommitContributions: number;
  totalPullRequestReviewContributions: number;
};

async function fetchYearTotals(
  user: string,
  windows: Array<{ from: Date; to: Date }>,
  env: Env,
): Promise<YearTotals> {
  const varDefs = ['$user:String!', ...windows.flatMap((_, i) => [`$from${i}:DateTime!`, `$to${i}:DateTime!`])].join(
    ',',
  );
  const selections = windows
    .map(
      (_, i) =>
        `y${i}: contributionsCollection(from:$from${i}, to:$to${i}) {
          totalCommitContributions
          totalPullRequestReviewContributions
        }`,
    )
    .join('\n');
  const variables: Record<string, unknown> = { user };
  windows.forEach((w, i) => {
    variables[`from${i}`] = w.from.toISOString();
    variables[`to${i}`] = w.to.toISOString();
  });
  const data = await ghGraphQL<{ user: Record<string, YearTotals> }>(
    env,
    `query(${varDefs}){ user(login:$user){ ${selections} } }`,
    variables,
  );
  let commits = 0;
  let reviews = 0;
  for (let i = 0; i < windows.length; i++) {
    const c = data.user[`y${i}`];
    if (!c) continue;
    commits += c.totalCommitContributions;
    reviews += c.totalPullRequestReviewContributions;
  }
  return { totalCommitContributions: commits, totalPullRequestReviewContributions: reviews };
}

async function fetchLifetimeTotals(user: string, createdAt: Date, env: Env): Promise<LifetimeTotals> {
  // Year windows run in parallel chunks — GitHub evaluates each contributionsCollection
  // serially inside a single query, which is what made /stats miss GitHub camo's ~5s budget.
  // Inventory + last-year total share one query. Private contribs included when self-token.
  const windows = yearWindows(createdAt);
  const today = new Date();
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const CHUNK = 1;
  const groups: Array<Array<{ from: Date; to: Date }>> = [];
  for (let i = 0; i < windows.length; i += CHUNK) groups.push(windows.slice(i, i + CHUNK));

  const [inventory, ...yearParts] = await Promise.all([
    ghGraphQL<{
      user: {
        pullRequests: { totalCount: number };
        mergedPRs: { totalCount: number };
        issues: { totalCount: number };
        repositoryDiscussions: { totalCount: number };
        repositoriesContributedTo: { totalCount: number };
        lastYear: { contributionCalendar: { totalContributions: number } };
      };
    }>(
      env,
      `query($user:String!,$lastFrom:DateTime!,$lastTo:DateTime!){
        user(login:$user){
          pullRequests{ totalCount }
          mergedPRs: pullRequests(states:MERGED){ totalCount }
          issues{ totalCount }
          repositoryDiscussions{ totalCount }
          repositoriesContributedTo(
            contributionTypes:[COMMIT, ISSUE, PULL_REQUEST, REPOSITORY, PULL_REQUEST_REVIEW]
            includeUserRepositories:true
          ){ totalCount }
          lastYear: contributionsCollection(from:$lastFrom, to:$lastTo){
            contributionCalendar{ totalContributions }
          }
        }
      }`,
      { user, lastFrom: oneYearAgo.toISOString(), lastTo: today.toISOString() },
    ),
    ...groups.map((g) => fetchYearTotals(user, g, env)),
  ]);

  let commits = 0;
  let reviews = 0;
  for (const p of yearParts) {
    commits += p.totalCommitContributions;
    reviews += p.totalPullRequestReviewContributions;
  }

  return {
    commits,
    prs: inventory.user.pullRequests.totalCount,
    prsMerged: inventory.user.mergedPRs.totalCount,
    prsReviewed: reviews,
    issues: inventory.user.issues.totalCount,
    reposContributed: inventory.user.repositoriesContributedTo.totalCount,
    lastYearContribs: inventory.user.lastYear.contributionCalendar.totalContributions,
    lastYearReposContributed: inventory.user.repositoriesContributedTo.totalCount,
    discussionsStarted: inventory.user.repositoryDiscussions.totalCount,
  };
}

// ─── Streak computation ─────────────────────────────────────────────────────
type Streak = {
  total: number;
  current: number;
  currentFrom: string;
  currentTo: string;
  longest: number;
  longestFrom: string;
  longestTo: string;
  since: string;
};

function computeStreak(days: Day[]): Streak {
  const total = days.reduce((a, d) => a + d.count, 0);
  let longest = 0;
  let longestFrom = '';
  let longestTo = '';
  let runStart = '';
  let run = 0;
  for (const d of days) {
    if (d.count > 0) {
      if (run === 0) runStart = d.date;
      run += 1;
      if (run > longest) {
        longest = run;
        longestFrom = runStart;
        longestTo = d.date;
      }
    } else {
      run = 0;
    }
  }
  // Current streak: walk backward from the latest day that is "today" in the series.
  // Grace: if the last calendar day (today) has 0 contributions, still count a streak
  // that ends on yesterday — but only that one trailing zero is skipped.
  let current = 0;
  let currentFrom = '';
  let currentTo = '';
  const todayIso = new Date().toISOString().slice(0, 10);
  let started = false;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (!started) {
      if (d.count > 0) {
        started = true;
        current = 1;
        currentFrom = d.date;
        currentTo = d.date;
        continue;
      }
      // Grace only for calendar today with no contribs yet.
      if (d.date === todayIso) continue;
      break;
    }
    if (d.count > 0) {
      current += 1;
      currentFrom = d.date;
    } else {
      break;
    }
  }
  return {
    total,
    current,
    currentFrom,
    currentTo,
    longest,
    longestFrom,
    longestTo,
    since: days[0]?.date ?? '',
  };
}

// ─── SVG rendering ──────────────────────────────────────────────────────────
const COLORS = {
  bg: '#111111',
  fg: '#f5f5f5',
  dim: '#a0a0a0',
  faint: '#6a6a6a',
  accent: '#f59a1f',
  accentDim: '#b06c10',
  line: 'rgba(255,255,255,0.08)',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso: string): string {
  // 'YYYY-MM-DD' -> 'D/M' (per screenshot). If year differs from current, append /YY.
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)}/${parseInt(m, 10)}`;
}
function fmtDateLong(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)}/${parseInt(m, 10)}/${y}`;
}
function fmtNumber(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// ─── /streak card ───────────────────────────────────────────────────────────
// Structurally matches DenverCoder1/github-readme-streak-stats dark theme, fire=DD2727.
// Original card license: MIT. https://github.com/DenverCoder1/github-readme-streak-stats
async function renderStreak(user: string, env: Env): Promise<Response> {
  const profile = await fetchUserProfile(user, env);
  const since = new Date(profile.created_at);
  const days = await fetchAllContributions(user, since, env);
  const s = computeStreak(days);

  // Theme (dark):
  const T = {
    bg: '#151515',
    border: 'transparent',
    sideNums: '#FEFEFE',
    sideLabels: '#FEFEFE',
    sideDates: '#9E9E9E',
    ring: '#FB8C00',
    fire: '#FB8C00',
    currStreakNum: '#FEFEFE',
    currStreakLabel: '#FB8C00',
    dividers: 'rgba(255,255,255,0.08)',
  };

  const W = 495;
  const H = 195;
  const c1 = 82.5;
  const cM = 247.5;
  const c3 = 412.5;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="isolation:isolate" viewBox="0 0 ${W} ${H}" width="${W}px" height="${H}px" direction="ltr" role="img" aria-label="GitHub streak for ${esc(user)}">
  <defs>
    <clipPath id="outer_rectangle"><rect width="${W}" height="${H}" rx="4.5"/></clipPath>
    <mask id="mask_out_ring_behind_fire">
      <rect width="${W}" height="${H}" fill="white"/>
      <ellipse cx="${cM}" cy="32" rx="13" ry="18" fill="black"/>
    </mask>
  </defs>
  <g clip-path="url(#outer_rectangle)">
    <rect fill="${T.bg}" stroke="${T.border}" rx="4.5" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}"/>

    <!-- separators -->
    <line x1="165" y1="28" x2="165" y2="170" stroke-width="1" stroke="${T.dividers}" stroke-linecap="square"/>
    <line x1="330" y1="28" x2="330" y2="170" stroke-width="1" stroke="${T.dividers}" stroke-linecap="square"/>

    <!-- col 1: Total Contributions -->
    <g transform="translate(${c1}, 48)">
      <text x="0" y="32" text-anchor="middle" fill="${T.sideNums}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="700" font-size="28px" font-variant-numeric="tabular-nums">${fmtNumberFull(s.total)}</text>
    </g>
    <g transform="translate(${c1}, 84)">
      <text x="0" y="32" text-anchor="middle" fill="${T.sideLabels}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="400" font-size="14px">Total Contributions</text>
    </g>
    <g transform="translate(${c1}, 114)">
      <text x="0" y="32" text-anchor="middle" fill="${T.sideDates}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="400" font-size="12px" font-variant-numeric="tabular-nums">${fmtDateLong(s.since)} - Present</text>
    </g>

    <!-- col 2: Current Streak -->
    <g transform="translate(${cM}, 108)">
      <text x="0" y="32" text-anchor="middle" fill="${T.currStreakLabel}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="700" font-size="14px">Current Streak</text>
    </g>
    <g transform="translate(${cM}, 130)">
      <text x="0" y="32" text-anchor="middle" fill="${T.sideDates}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="400" font-size="12px" font-variant-numeric="tabular-nums">${fmtDate(s.currentFrom)} - ${fmtDate(s.currentTo)}</text>
    </g>

    <!-- Ring (with mask cutting a slot for the fire icon) -->
    <g mask="url(#mask_out_ring_behind_fire)">
      <circle cx="${cM}" cy="71" r="40" fill="none" stroke="${T.ring}" stroke-width="5"/>
    </g>
    <!-- Fire icon -->
    <g transform="translate(${cM}, 19.5)" stroke-opacity="0">
      <path d="M -12 -0.5 L 15 -0.5 L 15 23.5 L -12 23.5 L -12 -0.5 Z" fill="none"/>
      <path d="M 1.5 0.67 C 1.5 0.67 2.24 3.32 2.24 5.47 C 2.24 7.53 0.89 9.2 -1.17 9.2 C -3.23 9.2 -4.79 7.53 -4.79 5.47 L -4.76 5.11 C -6.78 7.51 -8 10.62 -8 13.99 C -8 18.41 -4.42 22 0 22 C 4.42 22 8 18.41 8 13.99 C 8 8.6 5.41 3.79 1.5 0.67 Z M -0.29 19 C -2.07 19 -3.51 17.6 -3.51 15.86 C -3.51 14.24 -2.46 13.1 -0.7 12.74 C 1.07 12.38 2.9 11.53 3.92 10.16 C 4.31 11.45 4.51 12.81 4.51 14.2 C 4.51 16.85 2.36 19 -0.29 19 Z" fill="${T.fire}"/>
    </g>
    <!-- Current Streak big number -->
    <g transform="translate(${cM}, 48)">
      <text x="0" y="32" text-anchor="middle" fill="${T.currStreakNum}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="700" font-size="28px" font-variant-numeric="tabular-nums">${s.current}</text>
    </g>

    <!-- col 3: Longest Streak -->
    <g transform="translate(${c3}, 48)">
      <text x="0" y="32" text-anchor="middle" fill="${T.sideNums}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="700" font-size="28px" font-variant-numeric="tabular-nums">${s.longest}</text>
    </g>
    <g transform="translate(${c3}, 84)">
      <text x="0" y="32" text-anchor="middle" fill="${T.sideLabels}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="400" font-size="14px">Longest Streak</text>
    </g>
    <g transform="translate(${c3}, 114)">
      <text x="0" y="32" text-anchor="middle" fill="${T.sideDates}" font-family="'Segoe UI', Ubuntu, sans-serif" font-weight="400" font-size="12px" font-variant-numeric="tabular-nums">${fmtDate(s.longestFrom)} - ${fmtDate(s.longestTo)}</text>
    </g>
  </g>
</svg>`;

  return svgResponse(svg);
}

function fmtNumberFull(n: number): string {
  return n.toLocaleString('en-US');
}

// ─── /pulse card (windowed activity: 7d / 30d / 1y) ─────────────────────────
async function renderPulse(user: string, env: Env, range: Range): Promise<Response> {
  const [profile, pulse] = await Promise.all([
    fetchUserProfile(user, env),
    fetchPulse(user, range, env),
  ]);
  const name = (profile.name || profile.login).split(' ')[0];
  const cols: [string, string][] = [
    ['Commits', fmtNumberFull(pulse.commits)],
    ['PRs opened', fmtNumberFull(pulse.prs)],
    ['PRs merged', fmtNumberFull(pulse.prsMerged)],
    ['Reviews', fmtNumberFull(pulse.reviews)],
  ];

  const W = 720;
  const H = 195;
  const colW = W / cols.length;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub pulse for ${esc(user)}, ${esc(range.label)}">
  <defs>
    <style>
      .bg{fill:${COLORS.bg};stroke:rgba(255,255,255,0.08)}
      .title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:700;fill:${COLORS.fg};font-size:18px}
      .sub{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;fill:${COLORS.dim};font-size:10px;letter-spacing:0.16em;text-transform:uppercase}
      .num{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:700;fill:${COLORS.fg};font-size:28px;font-variant-numeric:tabular-nums}
      .lbl{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:400;fill:${COLORS.dim};font-size:13px}
      .div{stroke:rgba(255,255,255,0.08)}
    </style>
  </defs>
  <rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" ry="14"/>
  <text class="title" x="40" y="42">${esc(name)}'s Pulse</text>
  <text class="sub" x="40" y="64">${esc(range.label)} · public &amp; private</text>
  ${cols
    .map(([label, value], i) => {
      const cx = colW * i + colW / 2;
      const divider =
        i > 0 ? `<line class="div" x1="${colW * i}" y1="88" x2="${colW * i}" y2="${H - 24}"/>` : '';
      return `${divider}
    <text class="num" x="${cx}" y="128" text-anchor="middle">${esc(value)}</text>
    <text class="lbl" x="${cx}" y="154" text-anchor="middle">${esc(label)}</text>`;
    })
    .join('')}
</svg>`;
  return svgResponse(svg);
}

function fireIcon(): string {
  // Retained for completeness; the streak card now inlines the upstream path.
  return '';
}

// ─── /stats card ────────────────────────────────────────────────────────────
async function renderStats(user: string, env: Env): Promise<Response> {
  const profile = await fetchUserProfile(user, env);
  const [totals, discussionsAnswered] = await Promise.all([
    fetchLifetimeTotals(user, new Date(profile.created_at), env),
    fetchSearchTotal(`type:discussion answered-by:${user}`, env).catch(() => 0),
  ]);

  // Merge rate uses the same connection universe: MERGED ⊆ all authored PRs.
  const mergedPct =
    totals.prs > 0 ? Math.min(100, (totals.prsMerged / totals.prs) * 100) : 0;

  const grade = computeGrade({
    commits: totals.commits,
    prs: totals.prs,
    issues: totals.issues,
    reviews: totals.prsReviewed,
    followers: profile.followers,
    contribs: totals.lastYearContribs,
  });

  const name = (profile.name || profile.login).split(' ')[0];

  const rows: [string, string][] = [
    // Commits/reviews: contribution-graph totals (GitHub green-square rules; private when self).
    ['Total Commits', fmtNumberFull(totals.commits)],
    // PRs/issues: authored inventory from user.* connections (same family for merge %).
    ['Total Pull Requests', fmtNumberFull(totals.prs)],
    ['PRs Merged', `${fmtNumberFull(totals.prsMerged)}  ·  ${mergedPct.toFixed(1)}%`],
    ['PRs Reviewed', fmtNumberFull(totals.prsReviewed)],
    ['Issues Opened', fmtNumberFull(totals.issues)],
    ['Discussions Started', fmtNumberFull(totals.discussionsStarted)],
    ['Discussions Answered', fmtNumberFull(discussionsAnswered)],
    ['Contributions (last year)', fmtNumberFull(totals.lastYearContribs)],
    ['Repos contributed to', fmtNumberFull(totals.reposContributed)],
  ];

  const W = 720;
  const padX = 40;
  const titleY = 54;
  const eyebrowY = 82;
  const rowY0 = 118;
  const rowDY = 32;
  const H = rowY0 + rows.length * rowDY + 36;

  const circleR = 24;
  const circleCX = W - padX - circleR;
  const circleCY = 50;
  const gradeOffset = 2 * Math.PI * (circleR - 3) * (1 - grade.percent);
  const valEndX = W - padX;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub stats for ${esc(user)}">
  <defs>
    <style>
      .bg{fill:${COLORS.bg};stroke:rgba(255,255,255,0.08)}
      .title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:700;fill:${COLORS.fg};font-size:22px;letter-spacing:-0.01em}
      .eyebrow{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;fill:${COLORS.dim};font-size:10px;letter-spacing:0.18em;text-transform:uppercase}
      .k{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:400;fill:${COLORS.dim};font-size:14px}
      .v{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;fill:${COLORS.fg};font-size:14px;font-variant-numeric:tabular-nums}
      .grade{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:700;fill:${COLORS.fg};font-size:15px;letter-spacing:-0.01em}
      .rule{stroke:rgba(255,255,255,0.06)}
    </style>
  </defs>
  <rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" ry="16"/>

  <text class="title" x="${padX}" y="${titleY}">${esc(name)}'s GitHub Activity</text>
  <text class="eyebrow" x="${padX}" y="${eyebrowY}">Lifetime · public &amp; private</text>

  <!-- grade ring (top-right, flush with right padding) -->
  <g transform="translate(${circleCX}, ${circleCY})">
    <circle r="${circleR}" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
    <circle r="${circleR - 3}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2.5"/>
    <circle r="${circleR - 3}" fill="none" stroke="#ff9500" stroke-width="2.5"
            stroke-dasharray="${2 * Math.PI * (circleR - 3)}" stroke-dashoffset="${gradeOffset}"
            stroke-linecap="round" transform="rotate(-90)"/>
    <text class="grade" text-anchor="middle" dominant-baseline="central">${grade.letter}</text>
  </g>
  <text class="eyebrow" x="${circleCX}" y="${circleCY + circleR + 15}" text-anchor="middle">GRADE</text>

  <!-- horizontal rule under title -->
  <line class="rule" x1="${padX}" y1="${eyebrowY + 18}" x2="${W - padX}" y2="${eyebrowY + 18}"/>

  ${rows
    .map(([k, v], i) => {
      const y = rowY0 + i * rowDY;
      return `
    <text class="k" x="${padX}" y="${y}">${esc(k)}</text>
    <text class="v" x="${valEndX}" y="${y}" text-anchor="end">${esc(v)}</text>
    ${i < rows.length - 1 ? `<line class="rule" x1="${padX}" y1="${y + 12}" x2="${W - padX}" y2="${y + 12}"/>` : ''}`;
    })
    .join('')}
</svg>`;
  return svgResponse(svg);
}

type GradeInput = {
  commits: number;
  prs: number;
  issues: number;
  reviews: number;
  followers: number;
  contribs: number;
};

/** Rough rank heuristic across activity signals (no star component). */
function computeGrade(g: GradeInput): { letter: string; percent: number } {
  const COMMITS_M = 3000;
  const PRS_M = 250;
  const ISSUES_M = 80;
  const REVIEWS_M = 80;
  const FOLLOWERS_M = 150;
  const CONTRIBS_M = 3500;
  const score =
    0.28 * Math.min(g.commits / COMMITS_M, 1) +
    0.20 * Math.min(g.prs / PRS_M, 1) +
    0.12 * Math.min(g.issues / ISSUES_M, 1) +
    0.12 * Math.min(g.reviews / REVIEWS_M, 1) +
    0.08 * Math.min(g.followers / FOLLOWERS_M, 1) +
    0.20 * Math.min(g.contribs / CONTRIBS_M, 1);
  const letters: Array<[number, string]> = [
    [0.90, 'S'],
    [0.80, 'A+'],
    [0.70, 'A'],
    [0.60, 'A-'],
    [0.50, 'B+'],
    [0.40, 'B'],
    [0.30, 'B-'],
    [0.0, 'C'],
  ];
  for (const [th, letter] of letters) if (score >= th) return { letter, percent: score };
  return { letter: 'C', percent: score };
}

// ─── /graph (last 30 days line chart) ───────────────────────────────────────
async function renderGraph(user: string, env: Env, windowDays = 30): Promise<Response> {
  const today = new Date();
  const start = new Date(today);
  const span = Math.max(1, windowDays);
  start.setDate(start.getDate() - span);

  const [contribDays, profile] = await Promise.all([
    fetchContributionDays(
      user,
      start.toISOString().slice(0, 10),
      today.toISOString().slice(0, 10),
      env,
    ),
    fetchUserProfile(user, env),
  ]);
  const series = contribDays.slice(-(span + 1));

  const W = 920;
  const H = 340;
  const padL = 64;
  const padR = 30;
  const padT = 66;
  const padB = 52;

  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxCount = Math.max(10, ...series.map((d) => d.count));
  // Round up to a nice step
  const step = niceStep(maxCount);
  const maxY = Math.ceil(maxCount / step) * step;

  const stepX = innerW / Math.max(series.length - 1, 1);

  const yTicks: number[] = [];
  for (let y = 0; y <= maxY; y += step) yTicks.push(y);

  const path = series
    .map((d, i) => {
      const x = padL + i * stepX;
      const y = padT + innerH - (d.count / maxY) * innerH;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const dots = series
    .map((d, i) => {
      const x = padL + i * stepX;
      const y = padT + innerH - (d.count / maxY) * innerH;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${COLORS.faint}"/>`;
    })
    .join('');

  const name = (profile.name || profile.login).split(' ')[0];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Contribution graph for ${esc(user)}">
  <defs>
    <style>
      .bg{fill:${COLORS.bg};stroke:rgba(255,255,255,0.06)}
      .title{font-family:'Segoe UI',-apple-system,Helvetica,Arial,sans-serif;font-weight:700;fill:${COLORS.fg};font-size:16px}
      .axis{font-family:'Segoe UI',-apple-system,Helvetica,Arial,sans-serif;fill:${COLORS.dim};font-size:10px}
      .axisLabel{font-family:'Segoe UI',-apple-system,Helvetica,Arial,sans-serif;fill:${COLORS.fg};font-size:11px;font-weight:600}
      .grid{stroke:${COLORS.line};stroke-dasharray:2 3}
    </style>
  </defs>
  <rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" ry="14"/>
  <text class="title" x="${W / 2}" y="30" text-anchor="middle">${esc(name)}'s Contribution Graph</text>

  <!-- Y axis label -->
  <text class="axisLabel" transform="translate(18, ${padT + innerH / 2}) rotate(-90)" text-anchor="middle">Contributions</text>

  <!-- gridlines + y ticks -->
  ${yTicks
    .map((v) => {
      const y = padT + innerH - (v / maxY) * innerH;
      return `<line class="grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>
              <text class="axis" x="${padL - 8}" y="${y + 4}" text-anchor="end">${v}</text>`;
    })
    .join('\n')}

  <!-- line -->
  <path d="${path}" fill="none" stroke="${COLORS.fg}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}

  <!-- x axis: day numbers -->
  ${series
    .map((d, i) => {
      const x = padL + i * stepX;
      const day = parseInt(d.date.slice(8), 10);
      return `<text class="axis" x="${x}" y="${H - padB + 18}" text-anchor="middle">${day}</text>`;
    })
    .join('')}
  <text class="axisLabel" x="${W / 2}" y="${H - 10}" text-anchor="middle">Days</text>
</svg>`;
  return svgResponse(svg);
}

function niceStep(max: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
  for (const s of steps) if (max / s <= 6) return s;
  return 1000;
}

// ─── Error / index ──────────────────────────────────────────────────────────
function errorCard(msg: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="120" viewBox="0 0 560 120">
  <rect width="560" height="120" rx="14" fill="#111" stroke="rgba(255,0,0,0.4)"/>
  <text x="24" y="40" fill="#f5f5f5" font-family="Segoe UI,sans-serif" font-weight="700" font-size="16">dfstats error</text>
  <text x="24" y="70" fill="#e88" font-family="Segoe UI,sans-serif" font-size="12">${esc(msg).slice(0, 140)}</text>
</svg>`;
}

function indexPage(user: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>dfstats</title>
<style>body{font-family:system-ui;background:#111;color:#eee;padding:40px;max-width:900px;margin:auto}a{color:#6cf}img{max-width:100%;display:block;margin:12px 0;background:#000}</style>
<h1>dfstats</h1>
<p>Self-hosted GitHub profile cards for <code>${esc(user)}</code>.</p>
<ul>
  <li><code>/streak</code> — streak card</li>
  <li><code>/stats</code> — stats card with letter grade</li>
  <li><code>/graph</code> — 30-day contribution line chart</li>
</ul>
<img src="/streak"/>
<img src="/stats"/>
<img src="/graph"/>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
