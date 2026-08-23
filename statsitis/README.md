# statsitis

Self-hosted GitHub profile stat-card renderers. Pure TypeScript library with **no runtime dependencies** and **no third-party services** (no Vercel, no GitHub Readme Stats, no demolab — nothing). Everything renders inside the `dfwebsite` Cloudflare Worker.

## Endpoints (exposed by `website/src/pages/api/stats/[card].ts`)

| URL                                | What it returns                                                  |
|------------------------------------|------------------------------------------------------------------|
| `/api/stats/streak`                | Streak card (total / current / longest)                          |
| `/api/stats/stats`                 | Stats card with letter grade, lifetime totals (public + private) |
| `/api/stats/graph`                 | 30-day contribution line chart                                   |
| `/api/stats/health`                | `ok`                                                             |

All responses are SVG, cached on Cloudflare's edge for 30 minutes.

## How data is fetched

- GitHub GraphQL API (`api.github.com/graphql`) for contribution calendars and lifetime totals — walks yearly `contributionsCollection` windows from `createdAt` to now.
- GitHub REST for profile metadata, merged PRs, discussions.
- Authenticated with a fine-grained PAT stored as the `GH_TOKEN` secret on the `dfwebsite` Worker, so **private contributions are included** in my own totals.

## Architecture

```
 browser / GitHub camo
        │
        ▼
 dfwebsite Worker (Cloudflare, single worker for everything)
        ├── static assets  →  dist/client (Astro build)
        └── /api/stats/*   →  imports statsitis renderers in-process
                                     │
                                     └── api.github.com (GraphQL + REST)
```

No second Worker. No Vercel. No external rendering service.
