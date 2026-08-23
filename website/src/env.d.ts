/// <reference path="../.astro/types.d.ts" />

interface Env {
  GH_USER: string;
  GH_TOKEN?: string;
  ASSETS: Fetcher;
}

// Minimal Workers runtime typings (no @cloudflare/workers-types dependency).
declare module 'cloudflare:workers' {
  export const env: Env;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

declare namespace App {
  interface Locals extends Runtime {}
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;
