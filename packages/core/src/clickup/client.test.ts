import { describe, expect, it } from 'vitest';
import { ClickUpApiError, ConfigError, DoneGuardError, KitError } from '../errors.js';
import { createLogger, REDACTED } from '../logger.js';
import { ClickUpClient, DEFAULT_AGENT_STATUSES, type ClickUpClientOptions } from './client.js';
import { fakeApi, json, type FakeApi } from './fake-api.test-helper.js';

const TOKEN = 'pk_12345678_TESTTOKENTESTTOKENTESTTOKEN';

const LIST = {
  id: 'L1',
  name: 'Mobile',
  statuses: [
    { status: 'to do', type: 'open' },
    { status: 'coding', type: 'custom' },
    { status: 'in review', type: 'custom' },
    { status: 'testing', type: 'custom' },
    { status: 'Ready for Review', type: 'custom' },
    { status: 'complete', type: 'closed' },
  ],
};

function client(api: FakeApi, options: Partial<ClickUpClientOptions> = {}) {
  return new ClickUpClient({
    token: TOKEN,
    fetch: api.fetch,
    limiter: { sleep: async () => {}, random: () => 0 },
    ...options,
  });
}

/** A fake API with task T1 (status "to do") in list L1. */
function taskApi() {
  return fakeApi()
    .on('GET /v2/task/T1', { id: 'T1', name: 'Login', status: { status: 'to do' }, list: { id: 'L1' } })
    .on('GET /v2/list/L1', LIST)
    .on('PUT /v2/task/T1', { id: 'T1' });
}

describe('ClickUpClient construction', () => {
  it('needs a token', () => {
    expect(() => new ClickUpClient({ token: '  ' })).toThrow(ConfigError);
    expect(() => new ClickUpClient({ token: '' })).toThrow(/CLICKUP_API_TOKEN is missing/);
  });

  it('needs a workspace ID for custom task IDs', () => {
    expect(() => new ClickUpClient({ token: TOKEN, customTaskIds: true })).toThrow(/CLICKUP_WORKSPACE_ID/);
  });

  it('defaults the allow-list to the team statuses', () => {
    expect(client(fakeApi()).agentStatuses).toEqual(DEFAULT_AGENT_STATUSES);
    expect(client(fakeApi(), { agentStatuses: ['a'] }).agentStatuses).toEqual(['a']);
  });
});

describe('requests', () => {
  it('sends the token only in the Authorization header', async () => {
    const api = fakeApi().on('GET /v2/user', { user: { id: 7, username: 'dev' } });
    expect(await client(api).getUser()).toEqual({ id: 7, username: 'dev' });
    expect(api.calls[0]!.headers.authorization).toBe(TOKEN);
    expect(api.calls[0]!.query.toString()).not.toContain(TOKEN);
  });

  it('throws ClickUpApiError with status and body on HTTP errors', async () => {
    const api = fakeApi().on('GET /v2/task/X', json({ err: 'Task not found', ECODE: 'ITEM_015' }, 404));
    const err = await client(api)
      .getTask('X')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClickUpApiError);
    expect(err).toMatchObject({ status: 404, method: 'GET', path: '/task/X', body: { ECODE: 'ITEM_015' } });
  });

  it('keeps non-JSON error bodies readable', async () => {
    const api = fakeApi().on('GET /v2/user', new Response('<html>Bad gateway</html>', { status: 400 }));
    await expect(client(api).getUser()).rejects.toMatchObject({ body: { raw: '<html>Bad gateway</html>' } });
  });

  it('retries a 429 through the rate limiter', async () => {
    let n = 0;
    const api = fakeApi().on('GET /v2/user', () =>
      n++ === 0 ? json({ err: 'Rate limit' }, 429) : { user: { id: 1, username: 'u' } },
    );
    expect((await client(api).getUser()).id).toBe(1);
    expect(api.calls).toHaveLength(2);
  });

  it('logs retries without the token and wraps network errors', async () => {
    const lines: string[] = [];
    const logger = createLogger({ stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) });
    const c = new ClickUpClient({
      token: TOKEN,
      logger,
      limiter: { maxRetries: 1, sleep: async () => {}, random: () => 0 },
      fetch: async () => {
        throw new Error(`connect failed for ${TOKEN}`);
      },
    });
    const err = await c.getUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitError);
    expect((err as Error).message).toBe(`network error on GET /user: connect failed for ${REDACTED}`);
    expect(lines).toEqual(['[clickup] network error, retry 1 in 1s']);
  });

  it('adds custom task ID parameters to task endpoints', async () => {
    const api = fakeApi().on('GET /v2/task/EKM-12', { id: 'abc', name: 'x' });
    await client(api, { customTaskIds: true, workspaceId: '999' }).getTask('EKM-12');
    const q = api.calls[0]!.query;
    expect(q.get('custom_task_ids')).toBe('true');
    expect(q.get('team_id')).toBe('999');
    expect(q.get('include_subtasks')).toBe('true');
    expect(q.get('include_markdown_description')).toBe('true');
  });

  it('URL-encodes IDs', async () => {
    const api = fakeApi();
    await client(api)
      .getTask('a/b?c')
      .catch(() => {});
    expect(api.calls[0]!.path).toBe('/v2/task/a%2Fb%3Fc');
  });
});

describe('getComments', () => {
  const comment = (i: number) => ({ id: String(i), date: String(1_000 + i), comment_text: `c${i}` });

  it('pages backwards and returns all comments oldest first', async () => {
    // 30 comments, newest first: page 1 = 29..5, page 2 = 4..0
    const all = Array.from({ length: 30 }, (_, i) => comment(29 - i));
    const api = fakeApi().on('GET /v2/task/T1/comment', (call) => {
      const startId = call.query.get('start_id');
      const from = startId === null ? 0 : all.findIndex((c) => c.id === startId) + 1;
      return { comments: all.slice(from, from + 25) };
    });
    const comments = await client(api).getComments('T1');
    expect(comments.map((c) => c.id)).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.query.get('start')).toBe('1005');
    expect(api.calls[1]!.query.get('start_id')).toBe('5');
  });

  it('stops when a page repeats (no infinite loop)', async () => {
    const page = Array.from({ length: 25 }, (_, i) => comment(25 - i));
    const api = fakeApi().on('GET /v2/task/T1/comment', { comments: page });
    expect(await client(api).getComments('T1')).toHaveLength(25);
    expect(api.calls).toHaveLength(2);
  });

  it('handles a task with no comments', async () => {
    const api = fakeApi().on('GET /v2/task/T1/comment', { comments: [] });
    expect(await client(api).getComments('T1')).toEqual([]);
  });
});

describe('write commands', () => {
  it('postComment posts the text with notify_all false', async () => {
    const api = fakeApi().on('POST /v2/task/T1/comment', { id: 456, date: 1 });
    expect(await client(api).postComment('T1', 'hello\nworld')).toEqual({ id: '456' });
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/v2/task/T1/comment',
      body: { comment_text: 'hello\nworld', notify_all: false },
    });
  });

  it('postComment refuses empty text without calling the API', async () => {
    const api = fakeApi();
    await expect(client(api).postComment('T1', '  ')).rejects.toThrow('comment text is empty');
    expect(api.calls).toHaveLength(0);
  });

  it('notify assigns the comment to the owner and notifies', async () => {
    const api = fakeApi().on('POST /v2/task/T1/comment', { id: 1 });
    await client(api).notify('T1', 'Ready for review', '12345678');
    expect(api.calls[0]!.body).toEqual({ comment_text: 'Ready for review', notify_all: true, assignee: 12345678 });
  });

  it('notify needs a numeric owner ID', async () => {
    const api = fakeApi();
    await expect(client(api).notify('T1', 'x', '')).rejects.toThrow(ConfigError);
    await expect(client(api).notify('T1', 'x', 'bob')).rejects.toThrow(/CLICKUP_OWNER_USER_ID/);
    expect(api.calls).toHaveLength(0);
  });

  it('createSubtask creates a task in the parent list with the parent ID', async () => {
    const api = fakeApi()
      .on('GET /v2/task/EKM-1', { id: 'real1', name: 'Parent', list: { id: 'L1' } })
      .on('POST /v2/list/L1/task', (call) => ({ id: 'new1', ...(call.body as object) }));
    const created = await client(api, { customTaskIds: true, workspaceId: '9' }).createSubtask(
      'EKM-1',
      'Add API call',
      '- step 1',
    );
    expect(created.id).toBe('new1');
    expect(api.calls[1]).toMatchObject({
      method: 'POST',
      path: '/v2/list/L1/task',
      body: { name: 'Add API call', markdown_content: '- step 1', parent: 'real1' },
    });
  });

  it('createSubtask refuses an empty name', async () => {
    await expect(client(fakeApi()).createSubtask('T1', ' ')).rejects.toThrow('subtask name is empty');
  });
});

describe('setStatus (Done guard in the client)', () => {
  it('moves the task using the exact status name from the list', async () => {
    const api = taskApi();
    expect(await client(api).setStatus('T1', 'ready for review')).toEqual({
      taskId: 'T1',
      from: 'to do',
      to: 'Ready for Review',
    });
    const put = api.calls.find((c) => c.method === 'PUT')!;
    expect(put).toMatchObject({ path: '/v2/task/T1', body: { status: 'Ready for Review' } });
  });

  it.each(['done', 'Done', 'complete', 'Closed', 'not done'])(
    'refuses "%s" with exit code 2 and makes no API call',
    async (status) => {
      const api = taskApi();
      const err = await client(api)
        .setStatus('T1', status)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DoneGuardError);
      expect((err as DoneGuardError).exitCode).toBe(2);
      expect(api.calls).toHaveLength(0);
    },
  );

  it('refuses a status outside the allow-list without an API call', async () => {
    const api = taskApi();
    await expect(client(api, { agentStatuses: ['coding'] }).setStatus('T1', 'testing')).rejects.toThrow(
      /not an agent status/,
    );
    expect(api.calls).toHaveLength(0);
  });

  it('refuses an allowed name whose ClickUp type is closed, without changing the task', async () => {
    const api = taskApi().on('GET /v2/list/L1', {
      ...LIST,
      statuses: [...LIST.statuses.slice(0, 4), { status: 'Ready for Review', type: 'closed' }],
    });
    await expect(client(api).setStatus('T1', 'ready for review')).rejects.toThrow(DoneGuardError);
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('fails clearly when the status does not exist on the list', async () => {
    const api = taskApi().on('GET /v2/list/L1', { ...LIST, statuses: LIST.statuses.slice(0, 2) });
    await expect(client(api).setStatus('T1', 'testing')).rejects.toThrow(
      'status "testing" does not exist on list "Mobile" [L1]',
    );
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('uses custom task ID parameters on the PUT', async () => {
    const api = fakeApi()
      .on('GET /v2/task/EKM-1', { id: 'real1', name: 'x', list: { id: 'L1' } })
      .on('GET /v2/list/L1', LIST)
      .on('PUT /v2/task/EKM-1', {});
    await client(api, { customTaskIds: true, workspaceId: '9' }).setStatus('EKM-1', 'coding');
    const put = api.calls.find((c) => c.method === 'PUT')!;
    expect(put.query.get('custom_task_ids')).toBe('true');
    expect(put.query.get('team_id')).toBe('9');
  });

  it('fails when the task has no list', async () => {
    const api = fakeApi().on('GET /v2/task/T1', { id: 'T1', name: 'x' });
    await expect(client(api).setStatus('T1', 'coding')).rejects.toThrow('task T1 has no list');
  });
});

describe('reads', () => {
  it('getListTasks reads every page and sends filters as arrays', async () => {
    const api = fakeApi().on('GET /v2/list/L1/task', (call) =>
      call.query.get('page') === '0'
        ? { tasks: [{ id: 'a', name: 'A' }], last_page: false }
        : { tasks: [{ id: 'b', name: 'B' }], last_page: true },
    );
    const tasks = await client(api).getListTasks('L1', { statuses: ['to do', 'coding'], assignees: [42] });
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b']);
    const q = api.calls[0]!.query;
    expect(q.getAll('statuses[]')).toEqual(['to do', 'coding']);
    expect(q.getAll('assignees[]')).toEqual(['42']);
    expect(q.get('subtasks')).toBe('false');
  });

  it('getListTasks stops on an empty page', async () => {
    const api = fakeApi().on('GET /v2/list/L1/task', { tasks: [], last_page: false });
    expect(await client(api).getListTasks('L1')).toEqual([]);
    expect(api.calls).toHaveLength(1);
  });

  it('reads workspaces, spaces, folders, lists and statuses', async () => {
    const api = fakeApi()
      .on('GET /v2/team', { teams: [{ id: 'W', name: 'Tossana' }] })
      .on('GET /v2/team/W/space', { spaces: [{ id: 'S', name: 'Apps' }] })
      .on('GET /v2/space/S/folder', { folders: [{ id: 'F', name: 'Mobile', lists: [{ id: 'L1', name: 'Sprint' }] }] })
      .on('GET /v2/space/S/list', { lists: [{ id: 'L2', name: 'Loose' }] })
      .on('GET /v2/list/L1', LIST);
    const c = client(api);
    expect(await c.getWorkspaces()).toEqual([{ id: 'W', name: 'Tossana' }]);
    expect(await c.getSpaces('W')).toEqual([{ id: 'S', name: 'Apps' }]);
    expect((await c.getFolders('S'))[0]!.lists![0]!.id).toBe('L1');
    expect(await c.getFolderlessLists('S')).toEqual([{ id: 'L2', name: 'Loose' }]);
    expect(await c.getListStatuses('L1')).toHaveLength(6);
    expect(api.calls[1]!.query.get('archived')).toBe('false');
  });

  it('returns empty arrays when ClickUp leaves fields out', async () => {
    const api = fakeApi()
      .on('GET /v2/team', {})
      .on('GET /v2/team/W/space', {})
      .on('GET /v2/space/S/folder', {})
      .on('GET /v2/space/S/list', {})
      .on('GET /v2/list/L1', { id: 'L1', name: 'x' });
    const c = client(api);
    expect(await c.getWorkspaces()).toEqual([]);
    expect(await c.getSpaces('W')).toEqual([]);
    expect(await c.getFolders('S')).toEqual([]);
    expect(await c.getFolderlessLists('S')).toEqual([]);
    expect(await c.getListStatuses('L1')).toEqual([]);
  });

  it('getDocPages uses API v3 with the workspace ID', async () => {
    const api = fakeApi().on('GET /v3/workspaces/W/docs/D1/pages', [{ id: 'p1', name: 'Spec', content: '# hi' }]);
    expect(await client(api, { workspaceId: 'W' }).getDocPages('D1')).toEqual([
      { id: 'p1', name: 'Spec', content: '# hi' },
    ]);
    expect(api.calls[0]!.query.get('max_page_depth')).toBe('-1');
    expect(api.calls[0]!.query.get('content_format')).toBe('text/md');
  });

  it('getDocPages also accepts a { pages } response and needs a workspace ID', async () => {
    const api = fakeApi().on('GET /v3/workspaces/W/docs/D1/pages', { pages: [{ id: 'p1' }] });
    expect(await client(api, { workspaceId: 'W' }).getDocPages('D1')).toEqual([{ id: 'p1' }]);
    await expect(client(api).getDocPages('D1')).rejects.toThrow(/CLICKUP_WORKSPACE_ID/);
  });
});
