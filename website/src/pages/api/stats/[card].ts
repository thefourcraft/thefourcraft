import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleStatsRequest, type Env } from '../../../../../statsitis/src/index';

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const card = String(params.card || '');
  const allowed = new Set(['streak', 'stats', 'graph', 'health']);
  if (!allowed.has(card)) return new Response('not found', { status: 404 });

  const runtimeCtx = (locals as { cfContext?: ExecutionContext }).cfContext;
  const ctx: ExecutionContext = runtimeCtx ?? ({
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);

  return handleStatsRequest(request, env as Env, ctx, card);
};
