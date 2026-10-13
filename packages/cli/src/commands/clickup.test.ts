import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG, LIST, TOKEN, cli, fakeApi, json, tempProject, type TempProject } from '../test-utils.test-helper.js';
import { collectDocFiles, pageMarkdown } from './clickup.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const taskApi = () =>
  fakeApi()
    .on('GET /v2/task/T1', {
      id: 'T1',
      name: 'Login screen',
      status: { status: 'to do' },
      list: { id: 'L1', name: 'Mobile' },
      assignees: [{ id: 1, username: 'dara' }],
      markdown_description: '# Login\n- email',
      due_date: '1760000000000',
      tags: [{ name: 'ui' }],
      subtasks: [{ id: 'S1', name: 'API', status: { status: 'coding' } }],
    })
    .on('GET /v2/list/L1', LIST)
    .on('PUT /v2/task/T1', {})
    .on('POST /v2/task/T1/comment', { id: 99 });

const handoff = (p: TempProject, id = 'T1') => readFileSync(join(p.dir, '.agents', 'handoff', `${id}.md`), 'utf8');

describe('clickup get / comments', () => {
  it('prints the task as JSON with the markdown description', async () => {
    project = tempProject();
    const r = await cli(['clickup', 'get', 'T1'], { cwd: project.dir, api: taskApi() });
    expect(r.code).toBe(0);
    const task = JSON.parse(r.out);
    expect(task).toMatchObject({
      id: 'T1',
      name: 'Login screen',
      status: 'to do',
      assignees: ['dara'],
      description: '# Login\n- email',
      tags: ['ui'],
      subtasks: [{ id: 'S1', name: 'API', status: 'coding' }],
    });
  });

  it('prints comments oldest first', async () => {
    project = tempProject();
    const api = fakeApi().on('GET /v2/task/T1/comment', {
      comments: [
        { id: '2', date: '1760000060000', comment_text: 'second', user: { id: 1, username: 'bot' } },
        { id: '1', date: '1760000000000', comment_text: 'first' },
      ],
    });
    const r = await cli(['clickup', 'comments', 'T1'], { cwd: project.dir, api });
    expect(r.out.indexOf('first')).toBeLessThan(r.out.indexOf('second'));
    expect(r.out).toContain('· unknown · id 1');
  });

  it('says when there are no comments', async () => {
    project = tempProject();
    const api = fakeApi().on('GET /v2/task/T1/comment', { comments: [] });
    expect((await cli(['clickup', 'comments', 'T1'], { cwd: project.dir, api })).out).toBe('(no comments)\n');
  });
});

describe('clickup comment / notify / handoff', () => {
  const tricky = `He said "ship it" & it's 100% done-ish: $HOME %PATH% \`tick\` ខ្មែរ`;

  it('posts text with quotes and special characters unchanged, and appends to the handoff file', async () => {
    project = tempProject();
    const api = taskApi();
    const r = await cli(['clickup', 'comment', 'T1', tricky], { cwd: project.dir, api });
    expect(r).toMatchObject({ code: 0, out: 'OK: comment posted on T1\n' });
    expect(api.calls[0]!.body).toEqual({ comment_text: tricky, notify_all: false });
    expect(handoff(project)).toContain(`## 2026-10-09T12:00:00.000Z — ClickUp comment\n\n${tricky}\n`);
  });

  it('joins unquoted words and turns a literal \\n into a newline', async () => {
    project = tempProject();
    const api = taskApi();
    await cli(['clickup', 'comment', 'T1', 'line', 'one\\nline', 'two'], { cwd: project.dir, api });
    expect((api.calls[0]!.body as { comment_text: string }).comment_text).toBe('line one\nline two');
  });

  it('reads --file from a path with spaces, relative to the project, and strips BOM/CRLF', async () => {
    project = tempProject();
    project.write(
      'notes/agent comment.md',
      `${String.fromCharCode(0xfeff)}[AGENT: coder] [RESULT: DONE_CODING]\r\nSummary: "ok"\r\n`,
    );
    const api = taskApi();
    const r = await cli(['clickup', 'comment', 'T1', '--file', 'notes/agent comment.md'], { cwd: project.dir, api });
    expect(r.code).toBe(0);
    expect((api.calls[0]!.body as { comment_text: string }).comment_text).toBe(
      '[AGENT: coder] [RESULT: DONE_CODING]\nSummary: "ok"',
    );
  });

  it('deletes a comment file written in .tossana/tmp after posting, but never other files', async () => {
    project = tempProject();
    project.write('.tossana/tmp/T1-reviewer.md', 'from tmp');
    project.write('keep.md', 'keep me');
    const api = taskApi();
    await cli(['clickup', 'comment', 'T1', '--file', '.tossana/tmp/T1-reviewer.md'], { cwd: project.dir, api });
    await cli(['clickup', 'comment', 'T1', '--file', 'keep.md'], { cwd: project.dir, api });
    expect(existsSync(join(project.dir, '.tossana', 'tmp', 'T1-reviewer.md'))).toBe(false);
    expect(existsSync(join(project.dir, 'keep.md'))).toBe(true);
  });

  it('keeps the temp file when posting fails', async () => {
    project = tempProject();
    project.write('.tossana/tmp/T1-coder.md', 'retry me');
    const api = fakeApi().on('POST /v2/task/T1/comment', json({ err: 'boom' }, 400));
    const r = await cli(['clickup', 'comment', 'T1', '--file', '.tossana/tmp/T1-coder.md'], { cwd: project.dir, api });
    expect(r.code).toBe(1);
    expect(existsSync(join(project.dir, '.tossana', 'tmp', 'T1-coder.md'))).toBe(true);
  });

  it('reads stdin with -', async () => {
    project = tempProject();
    const api = taskApi();
    await cli(['clickup', 'comment', 'T1', '-'], { cwd: project.dir, api, stdin: 'from\nstdin "quoted"\n' });
    expect((api.calls[0]!.body as { comment_text: string }).comment_text).toBe('from\nstdin "quoted"');
  });

  it('refuses empty text without calling ClickUp', async () => {
    project = tempProject();
    const api = taskApi();
    const r = await cli(['clickup', 'comment', 'T1'], { cwd: project.dir, api });
    expect(r.code).toBe(1);
    expect(r.err).toContain('usage: comment <taskId>');
    expect(api.calls).toHaveLength(0);
  });

  it('notify assigns the comment to CLICKUP_OWNER_USER_ID', async () => {
    project = tempProject();
    const api = taskApi();
    const r = await cli(['clickup', 'notify', 'T1', 'Ready for you'], { cwd: project.dir, api });
    expect(r.out).toBe('OK: owner notified on T1\n');
    expect(api.calls[0]!.body).toEqual({ comment_text: 'Ready for you', notify_all: true, assignee: 777 });
    expect(handoff(project)).toContain('Owner notified');
  });

  it('notify explains a missing owner ID', async () => {
    project = tempProject({ env: `CLICKUP_API_TOKEN=${TOKEN}\n` });
    const r = await cli(['clickup', 'notify', 'T1', 'x'], { cwd: project.dir, api: taskApi() });
    expect(r.code).toBe(1);
    expect(r.err).toContain('CLICKUP_OWNER_USER_ID is missing');
  });

  it('handoff writes locally without any API call', async () => {
    project = tempProject({ env: null });
    const api = fakeApi();
    const r = await cli(['clickup', 'handoff', 'EKM-12', 'Files: a.ts'], { cwd: project.dir, api });
    expect(r.out).toBe(`OK: appended to ${join('.agents', 'handoff', 'EKM-12.md')}\n`);
    expect(handoff(project, 'EKM-12')).toContain('— Notes\n\nFiles: a.ts');
    expect(api.calls).toHaveLength(0);
  });

  it('handoff refuses a task ID that is not a safe file name', async () => {
    project = tempProject();
    const r = await cli(['clickup', 'handoff', '../x', 'hi'], { cwd: project.dir });
    expect(r).toMatchObject({ code: 1 });
    expect(r.err).toContain('invalid task id "../x"');
  });
});

describe('clickup status', () => {
  it('maps the role to the exact status name from agent.config.json', async () => {
    project = tempProject();
    const api = taskApi();
    const r = await cli(['clickup', 'status', 'T1', 'human'], { cwd: project.dir, api });
    expect(r).toMatchObject({ code: 0, out: 'OK: T1 to do -> Ready for Review\n' });
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toEqual({ status: 'Ready for Review' });
  });

  it.each([['done'], ['Done'], ['complete'], ['closed'], ['Mark', 'DONE']])(
    'refuses %s with exit code 2 and no API call',
    async (...words) => {
      project = tempProject();
      const api = taskApi();
      const r = await cli(['clickup', 'status', 'T1', ...words], { cwd: project.dir, api });
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^BLOCKED: agents may not set status/);
      expect(api.calls).toHaveLength(0);
    },
  );

  it('rejects raw status names and unknown roles, listing the roles', async () => {
    project = tempProject();
    const api = taskApi();
    const r = await cli(['clickup', 'status', 'T1', 'in', 'review'], { cwd: project.dir, api });
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown role "in review". Use one of: todo, coding, review, testing, human');
    expect(api.calls).toHaveLength(0);
  });

  it('uses the team default status names when there is no config yet', async () => {
    project = tempProject({ config: null });
    const api = taskApi().on('GET /v2/list/L1', {
      ...LIST,
      statuses: [{ status: 'In Review', type: 'custom' }],
    });
    const r = await cli(['clickup', 'status', 'T1', 'review'], { cwd: project.dir, api });
    expect(r.out).toBe('OK: T1 to do -> In Review\n');
  });
});

describe('clickup subtask / list / statuses / spaces / lists', () => {
  it('creates a subtask', async () => {
    project = tempProject();
    const api = taskApi().on('POST /v2/list/L1/task', { id: 'N1', name: 'API', url: 'u' });
    const r = await cli(['clickup', 'subtask', 'T1', 'API call', 'step 1\\nstep 2'], { cwd: project.dir, api });
    expect(JSON.parse(r.out)).toEqual({ id: 'N1', name: 'API', url: 'u' });
    expect(api.calls[1]!.body).toEqual({ name: 'API call', markdown_content: 'step 1\nstep 2', parent: 'T1' });
  });

  it('lists my tasks in a role status', async () => {
    project = tempProject();
    const api = fakeApi()
      .on('GET /v2/user', { user: { id: 42, username: 'me' } })
      .on('GET /v2/list/L1/task', {
        tasks: [{ id: 'A', name: 'Task A', status: { status: 'to do' } }],
        last_page: true,
      });
    const r = await cli(['clickup', 'list', '--status', 'todo', '--mine'], { cwd: project.dir, api });
    expect(r.out).toBe('A\tto do\tTask A\n');
    const q = api.calls[1]!.query;
    expect(q.getAll('statuses[]')).toEqual(['to do']);
    expect(q.getAll('assignees[]')).toEqual(['42']);
  });

  it('lists as JSON from another list, and says when it is empty', async () => {
    project = tempProject();
    const api = fakeApi().on('GET /v2/list/L9/task', { tasks: [], last_page: true });
    expect((await cli(['clickup', 'list', '--list', 'L9', '--json'], { cwd: project.dir, api })).out).toBe('[]\n');
    expect((await cli(['clickup', 'list', '--list', 'L9'], { cwd: project.dir, api })).out).toBe('(no tasks)\n');
  });

  it('list needs a config or --list', async () => {
    project = tempProject({ config: null });
    const r = await cli(['clickup', 'list'], { cwd: project.dir });
    expect(r.err).toContain('agent.config.json not found. Run: tossana-agents init');
  });

  it('shows statuses with roles and who may set them', async () => {
    project = tempProject();
    const api = fakeApi().on('GET /v2/list/L1', LIST);
    const r = await cli(['clickup', 'statuses'], { cwd: project.dir, api });
    expect(r.out).toMatch(/Ready for Review\s+type=custom\s+agent can set\s+role=human/);
    expect(r.out).toMatch(/complete\s+type=closed\s+HUMAN ONLY/);
    expect(r.out).not.toContain('WARNING');
  });

  it('warns about missing statuses', async () => {
    project = tempProject();
    const api = fakeApi().on('GET /v2/list/L2', {
      id: 'L2',
      name: 'Other',
      statuses: [{ status: 'to do', type: 'open' }],
    });
    const r = await cli(['clickup', 'statuses', 'L2'], { cwd: project.dir, api });
    expect(r.out).toContain('WARNING: missing statuses the agents need: coding, in review, testing, Ready for Review');
  });

  it('prints spaces and the full list tree', async () => {
    project = tempProject({ config: null });
    const api = fakeApi()
      .on('GET /v2/user', { user: { id: 42, username: 'me' } })
      .on('GET /v2/team', { teams: [{ id: 'W', name: 'Tossana' }] })
      .on('GET /v2/team/W/space', { spaces: [{ id: 'S', name: 'Apps' }] })
      .on('GET /v2/space/S/folder', { folders: [{ id: 'F', name: 'Mobile', lists: [{ id: 'L1', name: 'Sprint' }] }] })
      .on('GET /v2/space/S/list', { lists: [{ id: 'L2', name: 'Backlog' }] });
    const spaces = await cli(['clickup', 'spaces'], { cwd: project.dir, api });
    expect(spaces.out).toContain('Token user: me (user id 42)');
    expect(spaces.out).toContain('  Space: Apps  [S]');
    const lists = await cli(['clickup', 'lists'], { cwd: project.dir, api });
    expect(lists.out).toContain('      List: Sprint  [listId L1]');
    expect(lists.out).toContain('    List: Backlog  [listId L2]');
  });
});

describe('clickup sync-docs', () => {
  it('writes one markdown file per page plus an index, skipping archived pages', async () => {
    project = tempProject({
      config: {
        ...CONFIG,
        clickup: { ...CONFIG.clickup, workspaceId: 'W', docs: { ids: ['D1'], outDir: 'docs/specs' } },
      },
    });
    project.write('docs/specs/old.md', 'stale');
    const api = fakeApi().on('GET /v3/workspaces/W/docs/D1/pages', [
      { id: 'p1', name: 'Login Spec', content: 'FR-1', pages: [{ id: 'p2', name: 'Errors', content: 'FR-2' }] },
      { id: 'p3', name: 'Old', content: 'x', archived: true },
    ]);
    const r = await cli(['clickup', 'sync-docs'], { cwd: project.dir, api });
    expect(r.out).toBe('OK: 2 pages in docs/specs/ (3 updated, 1 removed)\n');
    const read = (f: string) => readFileSync(join(project.dir, 'docs', 'specs', f), 'utf8');
    expect(read('login-spec.md')).toBe('# Login Spec\n\nFR-1\n');
    expect(read('login-spec__errors.md')).toBe('# Errors\n\nFR-2\n');
    expect(read('INDEX.md')).toContain('- [Login Spec](./login-spec.md)');
    expect(() => read('old.md')).toThrow();
  });

  it('explains missing doc IDs', async () => {
    project = tempProject();
    const r = await cli(['clickup', 'sync-docs'], { cwd: project.dir });
    expect(r.err).toContain('no ClickUp Doc IDs');
  });

  it('adds "# <page name>" when the content has no heading', () => {
    expect(pageMarkdown('Login Spec', 'FR-1 text')).toBe('# Login Spec\n\nFR-1 text\n');
    expect(pageMarkdown('Empty', '')).toBe('# Empty\n');
    expect(pageMarkdown('Not a heading', '#hashtag first\n')).toBe('# Not a heading\n\n#hashtag first\n');
  });

  it('does not add a second heading when the content already starts with one', () => {
    expect(pageMarkdown('implementation – 01 architecture', '# Architecture\n\nText\n\n')).toBe(
      '# Architecture\n\nText\n',
    );
    expect(pageMarkdown('x', '\n  ## Sub heading\nText')).toBe('\n  ## Sub heading\nText\n');
    expect(pageMarkdown('x', `${String.fromCharCode(0xfeff)}# With BOM\n`)).toBe('# With BOM\n');
  });

  it('round-trips a page uploaded from a synced file without doubling the heading', async () => {
    project = tempProject({
      config: { ...CONFIG, clickup: { ...CONFIG.clickup, workspaceId: 'W', docs: { ids: ['D1'] } } },
    });
    const api = fakeApi().on('GET /v3/workspaces/W/docs/D1/pages', [
      { id: 'p1', name: 'implementation – 01 architecture', content: '# Architecture\n\nLayers.\n' },
    ]);
    await cli(['clickup', 'sync-docs'], { cwd: project.dir, api });
    expect(readFileSync(join(project.dir, 'docs', 'clickup', 'implementation-01-architecture.md'), 'utf8')).toBe(
      '# Architecture\n\nLayers.\n',
    );
  });

  it('gives duplicate page names unique file names', () => {
    const files = collectDocFiles([
      [
        { id: 'a', name: 'Spec' },
        { id: 'b', name: 'Spec' },
        { id: 'c', name: '!!!' },
      ],
    ]);
    expect(files.map((f) => f.file)).toEqual(['spec.md', 'spec-2.md', 'c.md']);
  });
});

describe('errors, help and options', () => {
  it('prints a clear fix for a revoked token (OAUTH_025) and never the token', async () => {
    project = tempProject();
    const api = fakeApi().on('GET /v2/task/T1', json({ err: 'Token invalid', ECODE: 'OAUTH_025' }, 401));
    const r = await cli(['clickup', 'get', 'T1'], { cwd: project.dir, api });
    expect(r.code).toBe(1);
    expect(r.err).toContain('ERROR: ClickUp 401 on GET /task/T1');
    expect(r.err).toContain('FIX: Your ClickUp token is not valid any more (OAUTH_025: token not found)');
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it('explains a missing token', async () => {
    project = tempProject({ env: null });
    const r = await cli(['clickup', 'get', 'T1'], { cwd: project.dir });
    expect(r.err).toContain('CLICKUP_API_TOKEN is missing');
  });

  it('accepts --cwd with spaces', async () => {
    project = tempProject();
    const r = await cli(['--cwd', 'My Project', 'clickup', 'handoff', 'T1', 'x'], {
      cwd: join(project.dir, '..'),
    });
    expect(r.code).toBe(0);
    expect(handoff(project)).toContain('x');
  });

  it('ignores an API URL override that is not localhost', async () => {
    project = tempProject();
    const api = taskApi();
    const r = await cli(['clickup', 'get', 'T1'], {
      cwd: project.dir,
      api,
      processEnv: { TOSSANA_CLICKUP_API_URL: 'https://evil.example.com/api' },
    });
    expect(r.err).toContain('ignoring TOSSANA_CLICKUP_API_URL');
    expect(api.calls[0]!.path).toBe('/v2/task/T1');
  });

  it('shows help with exit code 0 and fails on unknown commands', async () => {
    project = tempProject();
    const help = await cli(['clickup', '--help'], { cwd: project.dir });
    expect(help.code).toBe(0);
    expect(help.out).toContain('status <taskId> <role...>');
    const bad = await cli(['clickup', 'nope'], { cwd: project.dir });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("unknown command 'nope'");
  });

  it('prints the version', async () => {
    project = tempProject();
    expect((await cli(['--version'], { cwd: project.dir })).out).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
