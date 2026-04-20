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

// ─── Router ─────────────────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const user = (url.searchParams.get('user') || env.GH_USER || 'thefourcraft').trim();

    if (url.pathname === '/health') return text('ok');

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let body: Response;
    try {
      if (url.pathname === '/streak') body = await renderStreak(user, env);
      else if (url.pathname === '/stats') body = await renderStats(user, env);
      else if (url.pathname === '/graph') body = await renderGraph(user, env);
      else if (url.pathname === '/' || url.pathname === '/index.html') body = indexPage(user);
      else return new Response('not found', { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return svgResponse(errorCard(msg), 500, 60);
    }

    // Copy headers so we can mutate cache-control safely
    const headers = new Headers(body.headers);
    headers.set('Cache-Control', 'public, max-age=21600, s-maxage=21600');
    headers.set('CDN-Cache-Control', 'public, max-age=21600');
    const response = new Response(body.body, { status: body.status, headers });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

// ─── Response helpers ───────────────────────────────────────────────────────
function svgResponse(svg: string, status = 200, maxAge = 21600): Response {
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

/** Fetch all contribution days since user creation up to today. Caps at ~10 years. */
async function fetchAllContributions(user: string, since: Date, env: Env): Promise<Day[]> {
  const today = new Date();
  const all: Day[] = [];
  let cursor = new Date(since);
  // Walk year windows. GitHub's contributions endpoint accepts arbitrary date spans
  // but is fastest when we request ≤ ~1 year per call.
  while (cursor <= today) {
    const end = new Date(cursor);
    end.setFullYear(end.getFullYear() + 1);
    if (end > today) end.setTime(today.getTime());
    const chunk = await fetchContributionDays(
      user,
      cursor.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
      env,
    );
    all.push(...chunk);
    const next = new Date(end);
    next.setDate(next.getDate() + 1);
    cursor = next;
  }
  // Deduplicate by date (endpoint may include overlap boundary days).
  const byDate = new Map<string, number>();
  for (const d of all) byDate.set(d.date, d.count);
  return Array.from(byDate, ([date, count]) => ({ date, count })).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
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
  const r = await ghFetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=1`,
    env,
  );
  if (!r.ok) return 0;
  const d = (await r.json()) as { total_count: number };
  return d.total_count;
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

async function fetchLifetimeTotals(user: string, createdAt: Date, env: Env): Promise<LifetimeTotals> {
  // Walk yearly windows from account creation → now, summing contribution totals.
  // contributionsCollection counts INCLUDE private contributions when the
  // authenticated viewer is the same user as the queried login.
  const today = new Date();
  const yearStart = new Date(createdAt);
  let commits = 0;
  let prs = 0;
  let reviews = 0;
  let issues = 0;
  const reposContributedSet = new Set<string>();

  while (yearStart <= today) {
    const end = new Date(yearStart);
    end.setFullYear(end.getFullYear() + 1);
    if (end > today) end.setTime(today.getTime());

    const data = await ghGraphQL<{
      user: {
        contributionsCollection: {
          totalCommitContributions: number;
          totalPullRequestContributions: number;
          totalPullRequestReviewContributions: number;
          totalIssueContributions: number;
          commitContributionsByRepository: Array<{ repository: { nameWithOwner: string } }>;
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
            commitContributionsByRepository(maxRepositories:100){
              repository{ nameWithOwner }
            }
          }
        }
      }`,
      {
        user,
        from: yearStart.toISOString(),
        to: end.toISOString(),
      },
    );
    const c = data.user.contributionsCollection;
    commits += c.totalCommitContributions;
    prs += c.totalPullRequestContributions;
    reviews += c.totalPullRequestReviewContributions;
    issues += c.totalIssueContributions;
    for (const r of c.commitContributionsByRepository) reposContributedSet.add(r.repository.nameWithOwner);

    const next = new Date(end);
    next.setDate(next.getDate() + 1);
    yearStart.setTime(next.getTime());
  }

  // Last 365 days summary (separate single call for the "last year" metrics).
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const lastYear = await ghGraphQL<{
    user: {
      contributionsCollection: {
        contributionCalendar: { totalContributions: number };
        commitContributionsByRepository: Array<{ repository: { nameWithOwner: string } }>;
      };
    };
  }>(
    env,
    `query($user:String!,$from:DateTime!,$to:DateTime!){
      user(login:$user){
        contributionsCollection(from:$from,to:$to){
          contributionCalendar{ totalContributions }
          commitContributionsByRepository(maxRepositories:100){ repository{ nameWithOwner } }
        }
      }
    }`,
    { user, from: oneYearAgo.toISOString(), to: today.toISOString() },
  );

  // Merged PRs + discussions started (all-time, includes private when self).
  const totals = await ghGraphQL<{
    user: {
      pullRequests: { totalCount: number };
      mergedPRs: { totalCount: number };
      repositoryDiscussions: { totalCount: number };
    };
  }>(
    env,
    `query($user:String!){
      user(login:$user){
        pullRequests(states:MERGED){ totalCount }
        mergedPRs: pullRequests(states:MERGED){ totalCount }
        repositoryDiscussions{ totalCount }
      }
    }`,
    { user },
  );

  return {
    commits,
    prs,
    prsMerged: totals.user.mergedPRs.totalCount,
    prsReviewed: reviews,
    issues,
    reposContributed: reposContributedSet.size,
    lastYearContribs: lastYear.user.contributionsCollection.contributionCalendar.totalContributions,
    lastYearReposContributed:
      lastYear.user.contributionsCollection.commitContributionsByRepository.length,
    discussionsStarted: totals.user.repositoryDiscussions.totalCount,
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
  // Current streak: walk from the most recent day backward. A streak is ongoing if
  // today OR yesterday has contributions (allow a 1-day grace for today's contribs
  // not yet posted), and extends while previous days are non-zero.
  let current = 0;
  let currentFrom = '';
  let currentTo = '';
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) {
      if (current === 0) currentTo = days[i].date;
      current += 1;
      currentFrom = days[i].date;
    } else if (current === 0 && i === days.length - 1) {
      // today has none yet — keep scanning
      continue;
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
async function renderStreak(user: string, env: Env): Promise<Response> {
  const profile = await fetchUserProfile(user, env);
  const since = new Date(profile.created_at);
  const days = await fetchAllContributions(user, since, env);
  const s = computeStreak(days);

  const W = 720;
  const H = 230;
  const cx1 = 170;
  const cx2 = 360;
  const cx3 = 550;
  const cy = 118;

  const ringR = 58;
  const ringStroke = 6;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub streak for ${esc(user)}">
  <defs>
    <linearGradient id="ember" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffb347"/>
      <stop offset="55%" stop-color="#ff9500"/>
      <stop offset="100%" stop-color="#ff6a00"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="55%" r="55%">
      <stop offset="0%" stop-color="#ff9500" stop-opacity="0.18"/>
      <stop offset="70%" stop-color="#ff9500" stop-opacity="0"/>
    </radialGradient>
    <style>
      .bg{fill:${COLORS.bg};stroke:rgba(255,255,255,0.08)}
      .num{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:700;fill:${COLORS.fg};font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
      .label{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:500;fill:${COLORS.fg};font-size:13px;letter-spacing:0.02em}
      .eyebrow{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;fill:${COLORS.dim};font-size:10px;letter-spacing:0.14em;text-transform:uppercase}
      .dim{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:400;fill:${COLORS.dim};font-size:11px;font-variant-numeric:tabular-nums}
      .accent{fill:#ff9500}
      .sep{stroke:rgba(255,255,255,0.07)}
    </style>
  </defs>

  <rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" ry="16"/>

  <!-- hairline separators -->
  <line class="sep" x1="${(cx1 + cx2) / 2}" y1="44" x2="${(cx1 + cx2) / 2}" y2="${H - 44}"/>
  <line class="sep" x1="${(cx2 + cx3) / 2}" y1="44" x2="${(cx2 + cx3) / 2}" y2="${H - 44}"/>

  <!-- col 1: total -->
  <text class="eyebrow" x="${cx1}" y="${cy - 34}" text-anchor="middle">TOTAL</text>
  <text class="num" x="${cx1}" y="${cy}" text-anchor="middle" font-size="34">${fmtNumberFull(s.total)}</text>
  <text class="label" x="${cx1}" y="${cy + 24}" text-anchor="middle">Contributions</text>
  <text class="dim" x="${cx1}" y="${cy + 46}" text-anchor="middle">${fmtDateLong(s.since)} — Present</text>

  <!-- col 2: current streak ring -->
  <g transform="translate(${cx2}, ${cy - 4})">
    <circle r="${ringR + 6}" fill="url(#glow)"/>
    <circle r="${ringR}" fill="none" stroke="rgba(255,149,0,0.18)" stroke-width="${ringStroke}"/>
    <circle r="${ringR}" fill="none" stroke="url(#ember)" stroke-width="${ringStroke}"
            stroke-linecap="round" transform="rotate(-90)"
            stroke-dasharray="${2 * Math.PI * ringR}" stroke-dashoffset="0"/>
    <!-- flame icon at top of ring -->
    <g transform="translate(0, -${ringR + 2})">
      ${fireIcon()}
    </g>
    <text class="num" y="10" text-anchor="middle" font-size="30">${s.current}</text>
  </g>
  <text class="accent label" x="${cx2}" y="${cy + ringR + 22}" text-anchor="middle" style="font-weight:600">Current Streak</text>
  <text class="dim" x="${cx2}" y="${cy + ringR + 42}" text-anchor="middle">${fmtDate(s.currentFrom)} — ${fmtDate(s.currentTo)}</text>

  <!-- col 3: longest -->
  <text class="eyebrow" x="${cx3}" y="${cy - 34}" text-anchor="middle">LONGEST</text>
  <text class="num" x="${cx3}" y="${cy}" text-anchor="middle" font-size="34">${s.longest}</text>
  <text class="label" x="${cx3}" y="${cy + 24}" text-anchor="middle">Day Streak</text>
  <text class="dim" x="${cx3}" y="${cy + 46}" text-anchor="middle">${fmtDate(s.longestFrom)} — ${fmtDate(s.longestTo)}</text>
</svg>`;

  return svgResponse(svg);
}

function fmtNumberFull(n: number): string {
  return n.toLocaleString('en-US');
}

function fireIcon(): string {
  // Clean flame silhouette, 24×28 viewbox equivalent, centered on origin.
  return `<g transform="translate(-10, -11) scale(0.85)">
    <path d="M12 1.5 C 10.8 4.5, 7.5 6.5, 7.5 11 C 7.5 12.7, 8.1 14.4, 9.2 15.6 C 8.6 15.1, 8.2 14.3, 8.2 13.5 C 8.2 11.3, 10.2 10.6, 10.8 8 C 11.8 10.3, 14 11.2, 14 13.5 C 14 14.6, 13.3 15.6, 12.2 16 C 14.7 15.5, 16.5 13.2, 16.5 10.5 C 16.5 6.8, 13.4 5, 12 1.5 Z"
          fill="url(#ember)" stroke="#ffb347" stroke-width="0.4" stroke-linejoin="round"/>
  </g>`;
}

// ─── /stats card ────────────────────────────────────────────────────────────
async function renderStats(user: string, env: Env): Promise<Response> {
  const profile = await fetchUserProfile(user, env);
  const totals = await fetchLifetimeTotals(user, new Date(profile.created_at), env);

  // Discussions answered isn't directly queryable via GraphQL. Use the REST
  // search API as a best-effort signal (returns 0 if indexing hasn't caught up).
  const discussionsAnswered = await fetchSearchTotal(
    `type:discussion answered-by:${user}`,
    env,
  ).catch(() => 0);

  const mergedPct = totals.prs > 0 ? (totals.prsMerged / totals.prs) * 100 : 0;

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
    ['Total Commits', fmtNumberFull(totals.commits)],
    ['Total Pull Requests', fmtNumberFull(totals.prs)],
    ['PRs Merged', `${fmtNumberFull(totals.prsMerged)}  ·  ${mergedPct.toFixed(1)}%`],
    ['PRs Reviewed', fmtNumberFull(totals.prsReviewed)],
    ['Issues Opened', fmtNumberFull(totals.issues)],
    ['Discussions Started', fmtNumberFull(totals.discussionsStarted)],
    ['Discussions Answered', fmtNumberFull(discussionsAnswered)],
    ['Contributions (last year)', fmtNumberFull(totals.lastYearContribs)],
    ['Orgs & Repos Contributed to', fmtNumberFull(totals.reposContributed)],
  ];

  const W = 720;
  const padX = 40;
  const titleY = 54;
  const eyebrowY = 82;
  const rowY0 = 118;
  const rowDY = 32;
  const valX = W - 220;
  const H = rowY0 + rows.length * rowDY + 36;

  const circleCX = W - 100;
  const circleCY = titleY + 10;
  const circleR = 26;
  const circleC = 2 * Math.PI * circleR;
  const gradeOffset = circleC * (1 - grade.percent);

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

  <!-- grade pill (top-right) -->
  <g transform="translate(${circleCX}, ${circleCY})">
    <circle r="${circleR}" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.10)"/>
    <circle r="${circleR - 2}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="3"/>
    <circle r="${circleR - 2}" fill="none" stroke="${COLORS.fg}" stroke-width="3"
            stroke-dasharray="${2 * Math.PI * (circleR - 2)}" stroke-dashoffset="${2 * Math.PI * (circleR - 2) * (1 - grade.percent)}"
            stroke-linecap="round" transform="rotate(-90)"/>
    <text class="grade" text-anchor="middle" dominant-baseline="central">${grade.letter}</text>
  </g>
  <text class="eyebrow" x="${circleCX}" y="${circleCY + circleR + 16}" text-anchor="middle">GRADE</text>

  <!-- horizontal rule under title -->
  <line class="rule" x1="${padX}" y1="${eyebrowY + 18}" x2="${W - padX}" y2="${eyebrowY + 18}"/>

  ${rows
    .map(([k, v], i) => {
      const y = rowY0 + i * rowDY;
      return `
    <text class="k" x="${padX}" y="${y}">${esc(k)}</text>
    <text class="v" x="${W - padX}" y="${y}" text-anchor="end">${esc(v)}</text>
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
async function renderGraph(user: string, env: Env): Promise<Response> {
  // Use a 31-day window so "21-20" reads nicely (rolling month end-of-period).
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 30);

  const days = await fetchContributionDays(
    user,
    start.toISOString().slice(0, 10),
    today.toISOString().slice(0, 10),
    env,
  );
  // If the fetched range is short, pad.
  const series = days.slice(-31);

  const W = 900;
  const H = 300;
  const padL = 56;
  const padR = 24;
  const padT = 54;
  const padB = 42;

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

  const profile = await fetchUserProfile(user, env);
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
