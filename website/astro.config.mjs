// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://david-furman.com',
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
    prerenderEnvironment: 'node',
  }),
  // Preserve production URLs: every .html path from the legacy site
  // must 301 to its clean-URL equivalent so backlinks and indexed
  // URLs keep resolving.
  redirects: {
    '/index.html': '/',
    '/work.html': '/work',
    '/resume.html': '/opinions',
    '/resume': '/opinions',
    '/contact-me.html': '/contact',
    '/privacy-policy.html': '/privacy',
    // Production's "Investment" CTA linked to Investments.html; point
    // the legacy URL at the closest equivalent content block.
    '/Investments.html': '/work',
    '/investments': '/work',
  },
  integrations: [
    icon({
      include: {
        lucide: ['*'],
        'simple-icons': ['*'],
      },
    }),
    sitemap(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
  image: {
    responsiveStyles: true,
  },
  experimental: {
    clientPrerender: true,
  },
});
