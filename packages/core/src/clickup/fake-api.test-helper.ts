/**
 * A fake ClickUp API for tests: a `fetch` replacement that answers from route handlers
 * and records every call (method, path, query, headers, JSON body).
 */
import type { FetchLike } from './client.js';

export interface RecordedCall {
  method: string;
  /** Path after /api, e.g. "/v2/task/abc". */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | object | ((call: RecordedCall) => Response | object);

export interface FakeApi {
  fetch: FetchLike;
  calls: RecordedCall[];
  /** Adds a handler for "METHOD /path" (exact path after /api, no query). Later routes win. */
  on(route: string, reply: Reply): FakeApi;
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export function fakeApi(): FakeApi {
  const routes: [string, Reply][] = [];
  const calls: RecordedCall[] = [];
  const api: FakeApi = {
    calls,
    on(route, reply) {
      routes.unshift([route, reply]);
      return api;
    },
    fetch: async (url, init) => {
      const u = new URL(url);
      const call: RecordedCall = {
        method: init.method ?? 'GET',
        path: u.pathname.replace(/^\/api/, ''),
        query: u.searchParams,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const found = routes.find(([route]) => route === `${call.method} ${call.path}`);
      if (!found) return json({ err: `no fake route for ${call.method} ${call.path}` }, 404);
      const reply = typeof found[1] === 'function' ? found[1](call) : found[1];
      return reply instanceof Response ? reply : json(reply);
    },
  };
  return api;
}
