/// <reference path="../.astro/types.d.ts" />

interface Env {
  GOOGLE_CHAT_WEBHOOK_URL: string;
  ASSETS: Fetcher;
}

declare namespace App {
  interface Locals extends Runtime {}
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;
