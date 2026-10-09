/**
 * Write fence for scripts/copy-test-data.ts: every request that is not a GET must target the test
 * workspace. A blocked request never reaches the network: it gets a local 403 "BLOCKED" response
 * (not an exception, so the rate limiter does not retry it) and is recorded in `violations`.
 */
import type { FetchLike } from '../packages/core/dist/index.js';

export interface Fence {
  /** null = no writes allowed at all. */
  targetWorkspace: string | null;
  /** v2 list IDs in the target workspace (creating tasks there is allowed). */
  targetLists: Set<string>;
  violations: string[];
}

export const newFence = (): Fence => ({ targetWorkspace: null, targetLists: new Set(), violations: [] });

/** Why this request is blocked, or null when it is allowed. */
export function blockReason(method: string, url: string, fence: Fence): string | null {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return null;
  const path = new URL(url).pathname.replace(/^\/api/, '');
  if (!fence.targetWorkspace) return `BLOCKED ${m} ${path}: no target workspace set, writes are not allowed`;

  const v3 = /^\/v3\/workspaces\/([^/]+)\//.exec(path);
  if (v3) {
    return decodeURIComponent(v3[1]!) === fence.targetWorkspace
      ? null
      : `BLOCKED ${m} ${path}: workspace ${v3[1]} is not the target test workspace`;
  }
  const createTask = /^\/v2\/list\/([^/]+)\/task$/.exec(path);
  if (m === 'POST' && createTask) {
    return fence.targetLists.has(decodeURIComponent(createTask[1]!))
      ? null
      : `BLOCKED ${m} ${path}: list ${createTask[1]} is not in the target test workspace`;
  }
  return `BLOCKED ${m} ${path}: this script never makes this kind of write`;
}

export function fencedFetch(fence: Fence, inner: FetchLike = (url, init) => globalThis.fetch(url, init)): FetchLike {
  return (url, init) => {
    const reason = blockReason(init.method ?? 'GET', url, fence);
    if (!reason) return inner(url, init);
    fence.violations.push(reason);
    return Promise.resolve(
      new Response(JSON.stringify({ err: reason }), { status: 403, headers: { 'content-type': 'application/json' } }),
    );
  };
}
