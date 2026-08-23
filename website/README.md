# DF-Website

David Furman's personal website — built with **Astro 7**, **Tailwind CSS v4**, and deployed on **Cloudflare Workers** (Static Assets).

## Stack

- **[Astro 7](https://astro.build)** — `output: 'server'` with on-demand `/api/stats/*` routes
- **[Tailwind CSS v4](https://tailwindcss.com)** — design tokens defined via `@theme` in `src/styles/global.css`
- **[astro-icon](https://github.com/natemoo-re/astro-icon)** — Iconify (`lucide`, `simple-icons`)
- **Self-hosted fonts** — Inter Tight (variable) + M PLUS Rounded 1c via `@fontsource`
- **[Embla Carousel](https://www.embla-carousel.com/)** — featured-projects carousel
- **[Motion One](https://motion.dev)** — modern, tiny animation primitives
- **[Cloudflare Workers (Static Assets)](https://developers.cloudflare.com/workers/static-assets/)** — deployment via `@astrojs/cloudflare` adapter + Wrangler

## Project structure

```
src/
├── components/      Reusable Astro components (Nav, Footer, Hero, Cards…)
├── config/          Site-wide config (nav links, socials, analytics IDs)
├── content/         Content collections (opinions/)
├── i18n/            Locale contract (en/he/ru) for future localisation
├── layouts/         Shared page layouts (Base.astro)
├── pages/           Routes (index, work, opinions, contact, legal, 404)
│   └── api/stats/   Server endpoints — GitHub stat cards (see statsitis/)
└── styles/          Tailwind layer + design tokens
public/
├── images/          Static image assets
├── favicon.png      Site favicon
└── robots.txt
```

## Local development

```sh
npm install
npm run dev          # Astro dev server at http://localhost:4321
```

For previewing in the **actual** Cloudflare Workers runtime:

```sh
cp .dev.vars.example .dev.vars
# Edit .dev.vars and paste your GitHub PAT (GH_TOKEN)
npm run build
npm run preview      # Wrangler dev (full Workers runtime + secrets)
```

## Secrets

| Secret | Purpose | How to set |
|---|---|---|
| `GH_TOKEN` | GitHub PAT for `/api/stats/*` cards (private contributions included when it's the user's own token) | Local: `.dev.vars` · Production: `npx wrangler secret put GH_TOKEN` |

The contact page reveals email addresses behind a client-side policy gate; there is no form backend.

## Deployment

Pushes to the `production` branch trigger [.github/workflows/deploy.yml](../.github/workflows/deploy.yml), which builds and deploys the single `dfwebsite` Worker. To deploy manually:

```sh
npm run deploy       # astro build && wrangler deploy
```

Cloudflare Workers project name: `dfwebsite` (configured in `wrangler.jsonc`).

## Adding an opinion post

Drop a new `.md` file into `src/content/opinions/`:

```md
---
title: 'Post title'
summary: 'Short description.'
publishDate: 2026-08-23
draft: false          # optional, hides the post while true
---

Body text in markdown.
```

Schema is defined in `src/content.config.ts`.

## License

See [LICENSE.md](./LICENSE.md).
