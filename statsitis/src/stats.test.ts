/**
 * Unit tests for the shipped statsitis renderers.
 * Mocks only the external GitHub network boundary; exercises real
 * handleStatsRequest / renderStreak / renderStats / renderGraph code paths.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { handleStatsRequest, type Env } from './index.ts';

const USER = 'thefourcraft';
const ENV: Env = { GH_USER: USER, GH_TOKEN: 'test-token-not-real' };

function isoDays(n: number, startCount = 1): Array<{ date: string; contributionCount: number }> {
  const out: Array<{ date: string; contributionCount: number }> = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    const date = d.toISOString().slice(0, 10);
    out.push({ date, contributionCount: startCount + (i % 3) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function weeksFromDays(days: Array<{ date: string; contributionCount: number }>) {
  const weeks: Array<{ contributionDays: typeof days }> = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push({ contributionDays: days.slice(i, i + 7) });
  }
  return weeks;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installGithubMock() {
  const days = isoDays(60, 2);
  const weeks = weeksFromDays(days);

  const fetchMock = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('api.github.com/users/') && !url.includes('/repos') && !url.includes('/search')) {
      return jsonResponse({
        login: USER,
        name: 'David Furman',
        created_at: '2020-01-15T00:00:00Z',
        public_repos: 42,
        followers: 100,
      });
    }

    if (url.includes('api.github.com/users/') && url.includes('/repos')) {
      return jsonResponse([{ stargazers_count: 3, fork: false }]);
    }

    if (url.includes('api.github.com/search/')) {
      return jsonResponse({ total_count: 7 });
    }

    if (url.includes('api.github.com/graphql') && method === 'POST') {
      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : init?.body
            ? await new Response(init.body).text()
            : '{}';
      const payload = JSON.parse(bodyText) as { query?: string };
      const q = payload.query || '';

      const yearBlock = {
        totalCommitContributions: 1200,
        totalPullRequestReviewContributions: 40,
        contributionCalendar: {
          totalContributions: 900,
          weeks,
        },
      };
      const inventory = {
        pullRequests: { totalCount: 100 },
        mergedPRs: { totalCount: 84 },
        issues: { totalCount: 50 },
        repositoryDiscussions: { totalCount: 5 },
        repositoriesContributedTo: { totalCount: 12 },
      };

      const aliases = [...q.matchAll(/\b(y\d+|lastYear):/g)].map((m) => m[1]);
      const user: Record<string, unknown> = {};
      if (q.includes('mergedPRs') || q.includes('repositoriesContributedTo') || q.includes('pullRequests')) {
        Object.assign(user, inventory);
      }
      for (const alias of aliases) {
        user[alias] =
          alias === 'lastYear' ? { contributionCalendar: { totalContributions: 900 } } : yearBlock;
      }
      if (!aliases.length && q.includes('contributionsCollection')) {
        user.contributionsCollection = yearBlock;
      }
      return jsonResponse({ data: { user } });
    }

    return new Response(`unexpected fetch: ${method} ${url}`, { status: 500 });
  });

  return fetchMock;
}

function ctx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

// Minimal Cache API stub so handleStatsRequest does not throw in Node.
if (!(globalThis as { caches?: unknown }).caches) {
  const store = new Map<string, Response>();
  (globalThis as { caches: { default: Cache } }).caches = {
    default: {
      async match(request: RequestInfo | URL) {
        const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
        const hit = store.get(key);
        return hit ? hit.clone() : undefined;
      },
      async put(request: RequestInfo | URL, response: Response) {
        const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
        store.set(key, response.clone());
      },
      async delete() {
        return false;
      },
      async keys() {
        return [];
      },
      async matchAll() {
        return [];
      },
      async add() {},
      async addAll() {},
    } as unknown as Cache,
  };
}

test('health returns plain ok via shipped handleStatsRequest', async () => {
  const res = await handleStatsRequest(
    new Request('https://example.test/api/stats/health'),
    ENV,
    ctx(),
    'health',
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type') || '', /text\/plain/);
  assert.equal(await res.text(), 'ok');
});

test('streak card returns real SVG (not error card) with mocked GitHub', async () => {
  const fetchMock = installGithubMock();
  try {
    const res = await handleStatsRequest(
      new Request(`https://example.test/api/stats/streak?cb=${Date.now()}-streak`),
      ENV,
      ctx(),
      'streak',
    );
    const body = await res.text();
    assert.equal(res.status, 200, body.slice(0, 300));
    assert.match(res.headers.get('Content-Type') || '', /image\/svg\+xml/);
    assert.doesNotMatch(body, /dfstats error|user 401|graphql 401|GH_TOKEN required/);
    assert.match(body, /GitHub streak for thefourcraft/);
    assert.match(body, /Current Streak/);
    assert.match(body, /Longest Streak/);
    assert.match(body, /Total Contributions/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('stats card returns real SVG with activity rows via shipped renderer', async () => {
  const fetchMock = installGithubMock();
  try {
    const res = await handleStatsRequest(
      new Request(`https://example.test/api/stats/stats?cb=${Date.now()}-stats`),
      ENV,
      ctx(),
      'stats',
    );
    const body = await res.text();
    assert.equal(res.status, 200, body.slice(0, 300));
    assert.match(res.headers.get('Content-Type') || '', /image\/svg\+xml/);
    assert.doesNotMatch(body, /dfstats error|user 401|graphql 401|GH_TOKEN required/);
    assert.match(body, /GitHub stats for thefourcraft/);
    assert.match(body, /Total Commits/);
    assert.match(body, /Total Pull Requests/);
    // Lifetime commits: sum yearly contribution windows (mock 1200/year from 2020).
    assert.match(body, /Total Commits<\/text>\s*<text class="v"[^>]*>[\d,]+<\/text>/);
    // PR inventory from connection API (not contribution graph).
    assert.match(body, /Total Pull Requests<\/text>\s*<text class="v"[^>]*>100<\/text>/);
    // Merge rate must be merged/opened from same universe: 84/100 = 84.0% (never >100%).
    assert.match(body, /PRs Merged<\/text>\s*<text class="v"[^>]*>84  ·  84\.0%<\/text>/);
    assert.doesNotMatch(body, /\d{3,}\.\d%/); // no absurd 900%-style percentages
    assert.match(body, /Repos contributed to<\/text>\s*<text class="v"[^>]*>12<\/text>/);
    assert.match(body, /David&#39;s GitHub Activity|David's GitHub Activity/);
    // Values right-align to card padding (720 - 40), not inset under the grade ring.
    assert.match(body, /class="v" x="680" y="\d+" text-anchor="end"/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('second request for the same URL is a Cache API hit (no extra GitHub fetch)', async () => {
  const fetchMock = installGithubMock();
  const url = `https://example.test/api/stats/graph?cb=${Date.now()}-cache`;
  try {
    const first = await handleStatsRequest(new Request(url), ENV, ctx(), 'graph');
    assert.equal(first.status, 200);
    const githubCalls = fetchMock.mock.calls.length;
    assert.ok(githubCalls > 0);
    const second = await handleStatsRequest(new Request(url), ENV, ctx(), 'graph');
    assert.equal(second.status, 200);
    assert.equal(fetchMock.mock.calls.length, githubCalls);
    assert.equal(second.headers.get('x-dfstats-generated'), first.headers.get('x-dfstats-generated'));
  } finally {
    fetchMock.mock.restore();
  }
});

test('graph card returns real SVG contribution chart via shipped renderer', async () => {
  const fetchMock = installGithubMock();
  try {
    const res = await handleStatsRequest(
      new Request(`https://example.test/api/stats/graph?cb=${Date.now()}-graph`),
      ENV,
      ctx(),
      'graph',
    );
    const body = await res.text();
    assert.equal(res.status, 200, body.slice(0, 300));
    assert.match(res.headers.get('Content-Type') || '', /image\/svg\+xml/);
    assert.doesNotMatch(body, /dfstats error|user 401|graphql 401|GH_TOKEN required/);
    assert.match(body, /Contribution graph for thefourcraft/);
    assert.match(body, /Contribution Graph/);
    assert.match(body, /<path d="/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('invalid card path is 404 from shipped handler', async () => {
  const res = await handleStatsRequest(
    new Request('https://example.test/api/stats/nope'),
    ENV,
    ctx(),
    'nope',
  );
  assert.equal(res.status, 404);
});
