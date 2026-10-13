import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exec } from './exec.js';
import { pageSummary, relatedIds } from './task-context.js';
import { CONFIG, TOKEN, cli, fakeApi, json, tempProject, type TempProject } from './test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const ctxFile = (f: string) => readFileSync(join(project.dir, '.agents', 'context', 'T1', f), 'utf8');
const doc = (f: string) => readFileSync(join(project.dir, 'docs', 'clickup', f), 'utf8');

const TASK = {
  id: 'T1',
  name: 'Login screen',
  status: { status: 'to do', type: 'open' },
  url: 'https://app.clickup.com/t/T1',
  list: { id: 'L1' },
  parent: 'P1',
  assignees: [{ id: 7, username: 'sarat' }],
  markdown_description: 'Build the login screen.\n\n**AC-1** Email and password fields.',
  subtasks: [
    { id: 'S1', name: 'Validation', status: { status: 'to do', type: 'open' }, markdown_description: 'AC-2 errors' },
  ],
  linked_tasks: [
    { task_id: 'T1', link_id: 'L9' },
    { task_id: 'X5', link_id: 'T1' },
  ],
  dependencies: [
    { task_id: 'T1', depends_on: 'D1', type: 1 },
    { task_id: 'B2', depends_on: 'T1', type: 1 },
  ],
  attachments: [{ id: 'a1', title: 'login-mock.png', url: 'https://example.com/a1.png', extension: 'png' }],
};
const related = (id: string, name: string) => ({
  id,
  name,
  status: { status: 'coding', type: 'custom' },
  text_content: `${name} text`,
});

function api() {
  return fakeApi()
    .on('GET /v2/task/T1', TASK)
    .on('GET /v2/task/P1', {
      id: 'P1',
      name: 'Auth epic',
      status: { status: 'coding', type: 'custom' },
      markdown_description: 'All auth work.',
      subtasks: [
        { id: 'T1', name: 'Login screen', status: { status: 'to do' } },
        { id: 'T2', name: 'Signup screen', status: { status: 'testing' } },
      ],
    })
    .on('GET /v2/task/L9', related('L9', 'Design tokens'))
    .on('GET /v2/task/X5', related('X5', 'Analytics events'))
    .on('GET /v2/task/D1', related('D1', 'Auth API'))
    .on('GET /v2/task/B2', () => json({ err: 'no access' }, 401))
    .on('GET /v2/task/T1/comment', {
      comments: [
        {
          id: '2',
          date: '1760000600000',
          comment_text: 'Please use the brand button.',
          user: { id: 7, username: 'sarat' },
        },
        {
          id: '1',
          date: '1760000000000',
          comment_text: '[AGENT: orchestrator] [RESULT: STARTED] [ROUND: 1]\nSummary: go\nNext: coder',
        },
      ],
    })
    .on('GET /v3/workspaces/W/docs/D1/pages', [
      {
        id: 'p1',
        name: 'Login Spec',
        content: '# Login\n\nThe login screen lets a user sign in with email.\n\nFR-1 …',
      },
      { id: 'p2', name: 'Errors', content: '| table | only |\n\nShow a red message under the field.' },
    ]);
}

const withDocs = { ...CONFIG, clickup: { ...CONFIG.clickup, workspaceId: 'W', docs: { ids: ['D1'] } } };

describe('tossana-agents context', () => {
  it('writes the task bundle: task, parent, subtasks, linked tasks both ways, comments, attachments, INDEX', async () => {
    project = tempProject({ config: withDocs });
    const r = await cli(['context', 'T1'], { cwd: project.dir, api: api() });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[context] docs: 2 page(s) in docs/clickup/ (3 updated, 0 removed)');
    expect(r.out).toContain(
      '[context] task: INDEX.md, task.md, parent.md, subtasks.md, linked.md, comments.md, attachments.md',
    );

    expect(ctxFile('task.md')).toContain('# Task: Login screen');
    expect(ctxFile('task.md')).toContain('**AC-1** Email and password fields.');
    expect(ctxFile('parent.md')).toContain('# Parent task: Auth epic');
    expect(ctxFile('parent.md')).toContain('- Signup screen (T2) — testing');
    expect(ctxFile('parent.md')).not.toContain('- Login screen (T1)');
    expect(ctxFile('subtasks.md')).toContain('## Validation');
    const linked = ctxFile('linked.md');
    expect(linked).toContain('# Linked tasks');
    expect(linked).toContain('## Design tokens'); // T1 → L9
    expect(linked).toContain('## Analytics events'); // X5 → T1 (stored on the other side)
    expect(linked).toContain('# This task waits on\n\n## Auth API');
    expect(linked).toContain('# This task blocks\n\n## B2\n\n(not accessible with your ClickUp token)');
    const comments = ctxFile('comments.md');
    expect(comments.indexOf('[AGENT: orchestrator]')).toBeLessThan(comments.indexOf('Please use the brand button.'));
    expect(comments).toMatch(/## \d{4}-\d\d-\d\d \d\d:\d\d — sarat/);
    expect(ctxFile('attachments.md')).toContain('- [login-mock.png](https://example.com/a1.png) (png)');
    const index = ctxFile('INDEX.md');
    expect(index).toContain('- [comments.md](./comments.md) — 2 comment(s), 1 from people');
    expect(index).toContain('Project docs: `docs/clickup/INDEX.md`');
  });

  it('keeps the docs index short (one line per page) and writes only what changed', async () => {
    project = tempProject({ config: withDocs });
    await cli(['context', 'T1'], { cwd: project.dir, api: api() });
    const index = doc('INDEX.md');
    expect(index).toContain('- [Login Spec](./login-spec.md) — The login screen lets a user sign in with email.');
    expect(index).toContain('- [Errors](./errors.md) — Show a red message under the field.');
    expect(index).not.toMatch(/synced|\d{4}-\d\d-\d\dT/); // no timestamp: an unchanged sync changes no file
    const before = statSync(join(project.dir, 'docs', 'clickup', 'login-spec.md')).mtimeMs;

    const again = await cli(['context', 'T1'], { cwd: project.dir, api: api() });
    expect(again.out).toContain('(0 updated, 0 removed)');
    expect(statSync(join(project.dir, 'docs', 'clickup', 'login-spec.md')).mtimeMs).toBe(before);
  });

  it('goes on with the old docs when the Docs request fails', async () => {
    project = tempProject({ config: withDocs });
    await cli(['context', 'T1'], { cwd: project.dir, api: api() });
    const failing = api().on('GET /v3/workspaces/W/docs/D1/pages', () => json({ err: 'doc not found' }, 404));
    const r = await cli(['context', 'T1'], { cwd: project.dir, api: failing });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[context] warning: could not sync ClickUp Docs');
    expect(doc('login-spec.md')).toContain('The login screen');
    expect(ctxFile('INDEX.md')).toContain('Project docs: `docs/clickup/INDEX.md`');
  });

  it('a task without parent, links or attachments gets only task, comments and INDEX; --no-docs skips docs', async () => {
    project = tempProject();
    const plain = fakeApi()
      .on('GET /v2/task/T1', { id: 'T1', name: 'Small fix', status: { status: 'to do' } })
      .on('GET /v2/task/T1/comment', { comments: [] });
    const r = await cli(['context', 'T1', '--no-docs'], { cwd: project.dir, api: plain });
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(join(project.dir, '.agents', 'context', 'T1')).sort()).toEqual([
      'INDEX.md',
      'comments.md',
      'task.md',
    ]);
    expect(ctxFile('task.md')).toContain('(no description)');
    expect(plain.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('refuses ids that are not safe folder names', async () => {
    project = tempProject();
    expect((await cli(['context', '../x'], { cwd: project.dir, api: api() })).err).toContain('invalid task id');
  });
});

describe('helpers', () => {
  it('summarises a page in one line', () => {
    expect(pageSummary('\n\n## x\n\nThe **login** [screen](a.md) lets you sign in.\n')).toBe(
      'The login screen lets you sign in.',
    );
    expect(pageSummary('- first bullet item\n')).toBe('first bullet item');
    expect(pageSummary('')).toBe('');
    expect(pageSummary('word '.repeat(60)).length).toBeLessThanOrEqual(111);
  });

  it('finds related tasks from either side of a link or dependency', () => {
    expect(relatedIds(TASK as never)).toEqual({ linked: ['L9', 'X5'], waitingOn: ['D1'], blocking: ['B2'] });
  });
});

describe('run refreshes the context before the agent starts', () => {
  const AGENT = `const fs = require('fs'); console.log('context there: ' + fs.existsSync('.agents/context/T1/INDEX.md'));`;
  const git = (...args: string[]) => {
    const r = exec('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { cwd: project.dir });
    if (r.code !== 0) throw new Error(r.stderr);
  };
  function gitProject() {
    project = tempProject({
      config: { ...CONFIG, pipeline: { runner: 'custom' } },
      env: `CLICKUP_API_TOKEN=${TOKEN}\nAGENT_CMD=node agent.js {prompt}\n`,
    });
    project.write('agent.js', AGENT);
    project.write('.gitignore', '.env\n.agents/\n');
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  }
  const taskApi = () =>
    fakeApi()
      .on('GET /v2/task/T1', { id: 'T1', name: 'Login', status: { status: 'to do', type: 'open' }, list: { id: 'L1' } })
      .on('GET /v2/task/T1/comment', { comments: [] });

  it('writes .agents/context/T1/ first; --no-context skips it; the dry run says so', async () => {
    gitProject();
    const dry = await cli(['run', '--task', 'T1', '--dry-run'], { cwd: project.dir, exec });
    expect(dry.out).toMatch(/context: refresh ClickUp docs and \.agents[\\/]context[\\/]T1/);

    const r = await cli(['run', '--task', 'T1'], { cwd: project.dir, exec, api: taskApi() });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[context] task: INDEX.md, task.md, comments.md');
    expect(r.out).toContain('context there: true');

    gitProject();
    const skip = await cli(['run', '--task', 'T1', '--no-context'], { cwd: project.dir, exec, api: taskApi() });
    expect(skip.code, skip.err).toBe(0);
    expect(skip.out).toContain('context there: false');
    expect(existsSync(join(project.dir, '.agents', 'context'))).toBe(false);
  });
});
