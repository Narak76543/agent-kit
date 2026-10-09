import { describe, expect, it } from 'vitest';
import { blockReason, fencedFetch, newFence } from './write-fence.js';

const API = 'https://api.clickup.com/api';

const fence = () => {
  const f = newFence();
  f.targetWorkspace = 'TEST_WS';
  f.targetLists = new Set(['TEST_LIST']);
  return f;
};

describe('write fence', () => {
  it('allows every read', () => {
    expect(blockReason('GET', `${API}/v3/workspaces/COMPANY/docs`, newFence())).toBeNull();
    expect(blockReason('get', `${API}/v2/task/T1`, newFence())).toBeNull();
  });

  it('a never-opened fence (the source client) blocks every write, anywhere', async () => {
    const source = newFence();
    const sent: string[] = [];
    const fetch = fencedFetch(source, async (url) => {
      sent.push(url);
      return new Response('{}');
    });
    for (const [method, path] of [
      ['POST', '/v2/task/T1/comment'],
      ['PUT', '/v2/task/T1'],
      ['DELETE', '/v2/task/T1'],
      ['POST', '/v2/list/L1/task'],
      ['POST', '/v3/workspaces/COMPANY/docs'],
      ['POST', '/v3/workspaces/TEST_WS/docs/D/pages'],
      ['PATCH', '/v3/workspaces/COMPANY/docs/D/pages/P'],
    ] as const) {
      expect((await fetch(`${API}${path}`, { method })).status).toBe(403);
    }
    await fetch(`${API}/v2/task/T1`, { method: 'GET' });
    expect(sent).toEqual([`${API}/v2/task/T1`]);
    expect(source.violations).toHaveLength(7);
  });

  it('blocks every write before a target is set', () => {
    expect(blockReason('POST', `${API}/v3/workspaces/TEST_WS/docs`, newFence())).toMatch(/no target workspace set/);
  });

  it('allows v3 writes only in the target workspace', () => {
    expect(blockReason('POST', `${API}/v3/workspaces/TEST_WS/docs`, fence())).toBeNull();
    expect(blockReason('POST', `${API}/v3/workspaces/TEST_WS/docs/D/pages`, fence())).toBeNull();
    expect(blockReason('POST', `${API}/v3/workspaces/COMPANY/docs/D/pages`, fence())).toMatch(
      /workspace COMPANY is not/,
    );
    expect(blockReason('PUT', `${API}/v3/workspaces/COMPANY/docs/D/pages/P`, fence())).toMatch(/BLOCKED PUT/);
  });

  it('allows creating tasks only in lists of the target workspace', () => {
    expect(blockReason('POST', `${API}/v2/list/TEST_LIST/task`, fence())).toBeNull();
    expect(blockReason('POST', `${API}/v2/list/COMPANY_LIST/task`, fence())).toMatch(/list COMPANY_LIST is not/);
  });

  it('blocks every other kind of write, even in the target workspace', () => {
    for (const [m, p] of [
      ['PUT', '/v2/task/T1'],
      ['POST', '/v2/task/T1/comment'],
      ['DELETE', '/v2/task/T1'],
      ['POST', '/v2/list/TEST_LIST/task/extra'],
      ['PUT', '/v2/list/TEST_LIST'],
    ] as const) {
      expect(blockReason(m, `${API}${p}`, fence())).toMatch(/never makes this kind of write/);
    }
  });

  it('answers blocked requests locally with 403 (no network, no retry) and records them', async () => {
    const f = fence();
    const sent: string[] = [];
    const fetch = fencedFetch(f, async (url) => {
      sent.push(url);
      return new Response('{}');
    });
    const blocked = await fetch(`${API}/v2/task/T1/comment`, { method: 'POST' });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ err: expect.stringMatching(/^BLOCKED POST/) });
    await fetch(`${API}/v3/workspaces/TEST_WS/docs`, { method: 'POST' });
    expect(sent).toEqual([`${API}/v3/workspaces/TEST_WS/docs`]);
    expect(f.violations).toHaveLength(1);
  });
});
