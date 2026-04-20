# dfstats

Self-hosted Cloudflare Worker that serves three SVG cards for my GitHub profile README:

- `GET /streak` — total contributions / current streak / longest streak
- `GET /stats`  — David's GitHub Stats card with letter grade
- `GET /graph`  — 30-day contribution line chart

Live at **https://stats.david-furman.com** (see `/` for an index).

## How it works

- Contribution data (daily counts, streaks, graph series) comes from the GitHub
  GraphQL API using a fine-grained PAT stored as the Worker secret `GH_TOKEN`.
- Stats card numbers (stars, commits, PRs, merged, issues, reviews, discussions,
  contributed-to) come from the GitHub REST Search API, same token.
- Grade letter is computed locally with a small rank heuristic.
- Every response is cached in the Cloudflare edge cache for 6 hours.

## Deploy

```sh
npm install
npx wrangler secret put GH_TOKEN    # fine-grained PAT, public repos + read:user
npx wrangler deploy
```

Custom domain `stats.david-furman.com` is attached via the Workers Domains API
against account `be4498f6a65885610876f17fddc1e68f`.
