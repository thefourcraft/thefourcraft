# DF-Website

David Furman's personal website — built with **Astro 6**, **Tailwind CSS v4**, and deployed on **Cloudflare Workers** (Static Assets).

## Stack

- **[Astro 6](https://astro.build)** — `output: 'static'` with one on-demand `/api/contact` route
- **[Tailwind CSS v4](https://tailwindcss.com)** — design tokens defined via `@theme` in `src/styles/global.css`
- **[astro-icon](https://github.com/natemoo-re/astro-icon)** — Iconify (`lucide`, `simple-icons`)
- **Self-hosted fonts** — Inter Tight (variable) + M PLUS Rounded 1c via `@fontsource`
- **[Embla Carousel](https://www.embla-carousel.com/)** — featured-projects carousel
- **[Motion One](https://motion.dev)** — modern, tiny animation primitives
- **[Cloudflare Workers (Static Assets)](https://developers.cloudflare.com/workers/static-assets/)** — deployment via `@astrojs/cloudflare` adapter + Wrangler

## Project structure

```
src/
├── components/      Reusable Astro components (Nav, Footer, Hero, Cards, Forms…)
├── config/          Site-wide config (nav links, socials, analytics IDs)
├── content/         Content collections (projects/)
├── layouts/         Shared page layouts (Base.astro)
├── pages/           Routes (index, work, resume, contact, privacy, 404)
│   └── api/         Server endpoints (contact)
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
# Edit .dev.vars and paste your Google Chat webhook URL
npm run build
npm run preview      # Wrangler dev (full Workers runtime + secrets)
```

## Secrets

The contact form posts to `/api/contact`, which forwards messages to a private Google Chat
space webhook. The webhook URL is **never** committed.

| Environment | How to set |
|---|---|
| Local | Copy `.dev.vars.example` → `.dev.vars` and fill in `GOOGLE_CHAT_WEBHOOK_URL` |
| Production | `npx wrangler secret put GOOGLE_CHAT_WEBHOOK_URL` |

## Deployment

```sh
npm run deploy       # astro build && wrangler deploy
```

Cloudflare Workers project name: `df-website` (configured in `wrangler.toml`).

## Adding a project

Drop a new `.md` file into `src/content/projects/`:

```md
---
title: 'Project name'
slug: 'project-slug'
role: 'My role'
summary: 'Short description.'
image: '/images/project-logo.png'
href: 'https://example.com'   # optional
tags: ['tag-a', 'tag-b']
featured: true                 # show on Work-page carousel
order: 1
---
```

Schema is defined in `src/content.config.ts`.

## License

See [LICENSE.md](./LICENSE.md).
