/** watch, worktrees, feedback, review, notifications (plan Phase 10, steps 3–5). Real git and node; fake ClickUp. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatAgentComment, parseConfig } from '@tossana/agents-core';
import { readWatchState, parseInterval } from './commands/watch.js';
import { exec as realExec, type Exec, type ExecResult } from './exec.js';
import { pendingFeedback } from './feedback.js';
import { notify } from './notify.js';
import { CONFIG, TOKEN, cli, fakeApi, tempProject, type TempProject } from './test-utils.test-helper.js';
import { worktreePath } from './worktrees.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const LIST = {
  id: 'L1',
  name: 'Mobile',
  statuses: ['to do', 'coding', 'in review', 'testing', 'ready for review'].map((status) => ({
    status,
    type: 'custom',
  })),
};
const comment = (id: string, text: string, user = 'sarat') => ({
  id,
  date: String(1760000000000 + Number(id)),
  comment_text: text,
  user: { id: 7, username: user },
});
const agent = (id: string, a: string, result: string, round = 1) =>
  comment(
    id,
    formatAgentComment({ agent: a, result: result as never, round, summary: `${a} ${result}`, next: 'human' }),
    'bot',
  );

/** The fake agent: records where it ran and its prompt, then exits. */
const AGENT = `require('fs').writeFileSync('ran-here.txt', process.cwd() + '\\n' + process.argv[2]);`;

/** Real git and node; tool version checks, notifications and PowerShell faked. Records every call. */
function execWith(
  overrides: Record<string, Partial<ExecResult>> = {},
): Exec & { calls: { cmd: string; args: string[]; env?: Record<string, string> }[] } {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const run = ((
    cmd: string,
    args: string[],
    o?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ) => {
    calls.push({ cmd, args, env: o?.env });
    const key = [cmd, ...args].join(' ');
    const hit = Object.keys(overrides).find((k) => key.startsWith(k));
    if (hit) return { code: 0, stdout: '', stderr: '', ...overrides[hit] };
    if (cmd === 'git' || cmd === 'node') return realExec(cmd, args, o);
    if (args[0] === '--version' && ['npm', 'pnpm', 'opencode'].includes(cmd))
      return { code: 0, stdout: '1.0.0\n', stderr: '' };
    if (cmd === 'notify-send' || cmd === 'osascript' || cmd === 'powershell')
      return { code: 0, stdout: '', stderr: '' };
    return { code: null, stdout: '', stderr: '', error: new Error(`spawn ${cmd} ENOENT`) };
  }) as Exec & { calls: { cmd: string; args: string[]; env?: Record<string, string> }[] };
  run.calls = calls;
  return run;
}

const git = (cwd: string, ...args: string[]) => {
  const r = realExec('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A git project set up with init (custom runner = the fake agent), committed on main. */
async function setUp(options: { install?: string } = {}) {
  project = tempProject({
    config: {
      ...CONFIG,
      tools: ['opencode'],
      commands: { install: options.install ?? "node -e \"require('fs').writeFileSync('installed.txt','yes')\"" },
      pipeline: { runner: 'custom' },
    },
    env: `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\nAGENT_CMD=node "fake agent/agent.js" {prompt}\n`,
  });
  project.write('fake agent/agent.js', AGENT);
  project.write(
    '.gitignore',
    '.env\n.agents/logs/\n.agents/handoff/\n.agents/context/\n.tossana/tmp/\ninstalled.txt\nran-here.txt\n',
  );
  git(project.dir, 'init', '-q', '-b', 'main');
  const r = await cli(['init', '--yes', '--no-doctor'], {
    cwd: project.dir,
    exec: execWith(),
    api: fakeApi().on('GET /v2/list/L1', LIST),
  });
  expect(r.code, r.err).toBe(0);
  git(project.dir, 'add', '-A');
  git(project.dir, 'commit', '-q', '-m', 'init');
}

/** ClickUp for watch: T1 in "to do"; T2 in "coding" with the owner's feedback after a finished pipeline. */
function watchApi(options: { feedback?: boolean } = {}) {
  const getCount: Record<string, number> = {};
  const status = (id: string, first: string) => () => {
    getCount[id] = (getCount[id] ?? 0) + 1;
    // The first look (the run's own check) sees the starting status; afterwards the agents have finished.
    const s = getCount[id] === 1 ? first : 'ready for review';
    return { id, name: `Task ${id}`, status: { status: s, type: 'custom' }, list: { id: 'L1' } };
  };
  const api = fakeApi()
    .on('GET /v2/user', { user: { id: 7, username: 'sarat' } })
    .on('GET /v2/list/L1', LIST)
    .on('GET /v2/list/L1/task', (call) => {
      const st = call.query.getAll('statuses[]')[0];
      if (st === 'to do')
        return { tasks: [{ id: 'T1', name: 'Task T1', status: { status: 'to do' } }], last_page: true };
      if (st === 'coding' && options.feedback)
        return { tasks: [{ id: 'T2', name: 'Task T2', status: { status: 'coding' } }], last_page: true };
      return { tasks: [], last_page: true };
    })
    .on('GET /v2/task/T1', status('T1', 'to do'))
    .on('GET /v2/task/T2', status('T2', 'coding'))
    .on('GET /v2/task/T1/comment', { comments: [agent('3', 'orchestrator', 'PASS')] })
    .on('GET /v2/task/T2/comment', {
      comments: [
        comment('5', 'Please make the button blue.'),
        agent('4', 'orchestrator', 'PASS'),
        agent('1', 'orchestrator', 'STARTED'),
      ],
    })
    .on('POST /v2/task/T2/comment', { id: '9' })
    .on('PUT /v2/task/T2', {});
  return api;
}

describe('worktrees', () => {
  it('watch runs a new task in <repo>-tasks/<id> on task/<id>: .env copied, install run, main folder untouched', async () => {
    await setUp();
    const exec = execWith();
    const r = await cli(['watch', '--once', '--ai-orchestrator'], { cwd: project.dir, exec, api: watchApi() });
    expect(r.code, r.err).toBe(0);

    const wt = worktreePath(project.dir, 'T1');
    expect(git(wt, 'branch', '--show-current')).toBe('task/T1');
    expect(readFileSync(join(wt, 'installed.txt'), 'utf8')).toBe('yes');
    expect(readFileSync(join(wt, '.env'), 'utf8')).toContain('AGENT_CMD=');
    const [where] = readFileSync(join(wt, 'ran-here.txt'), 'utf8').split('\n');
    expect(realpathSync(where!)).toBe(realpathSync(wt));
    // The developer's folder: still on main, nothing run there.
    expect(git(project.dir, 'branch', '--show-current')).toBe('main');
    expect(existsSync(join(project.dir, 'ran-here.txt'))).toBe(false);

    expect(r.out).toContain('[watch] T1: ready');
    expect(readWatchState(project.dir).tasks.T1).toMatchObject({ state: 'ready', kind: 'new', attempts: 1 });
    expect(exec.calls.some((c) => c.cmd === 'notify-send' && c.args[0] === 'Ready for review: Task T1')).toBe(true);
  });

  it('tracked files the install changes in a new worktree are restored (pnpm and a local file: dependency)', async () => {
    // pnpm rewrites the relative path of a "file:" dependency in the lockfile: the worktree is one folder deeper.
    await setUp({ install: "node -e \"require('fs').writeFileSync('lock.yaml','../../kit.tgz')\"" });
    project.write('lock.yaml', '../kit.tgz');
    git(project.dir, 'add', '-A');
    git(project.dir, 'commit', '-q', '-m', 'lockfile');
    const r = await cli(['watch', '--once', '--ai-orchestrator'], {
      cwd: project.dir,
      exec: execWith(),
      api: watchApi(),
    });
    expect(r.code, r.err).toBe(0);
    const wt = worktreePath(project.dir, 'T1');
    expect(r.out).toContain('[worktree] the install changed lock.yaml; restored');
    expect(readFileSync(join(wt, 'lock.yaml'), 'utf8')).toBe('../kit.tgz');
    expect(existsSync(join(wt, 'ran-here.txt'))).toBe(true);
    expect(r.out).toContain('[watch] T1: ready');
  });

  it('a stale task branch (no own commits) is moved to main; one with own commits is kept', async () => {
    await setUp();
    git(project.dir, 'branch', 'task/T1'); // left by a failed run, on the old main
    project.write('NEW.md', 'newer main');
    git(project.dir, 'add', '-A');
    git(project.dir, 'commit', '-q', '-m', 'main moved on');
    const r = await cli(['watch', '--once', '--ai-orchestrator'], {
      cwd: project.dir,
      exec: execWith(),
      api: watchApi(),
    });
    expect(r.out).toContain('task/T1 had no commits of its own: moved it to main');
    expect(existsSync(join(worktreePath(project.dir, 'T1'), 'NEW.md'))).toBe(true);
  });

  it('refuses a task branch that is checked out in the main folder, with the fix', async () => {
    await setUp();
    git(project.dir, 'switch', '-q', '-c', 'task/T1');
    git(project.dir, 'commit', '-q', '--allow-empty', '-m', 'own work');
    const r = await cli(['watch', '--once', '--ai-orchestrator'], {
      cwd: project.dir,
      exec: execWith(),
      api: watchApi(),
    });
    expect(r.err).toContain('task/T1 is checked out in');
    expect(r.err).toContain('git switch main');
    expect(readWatchState(project.dir).tasks.T1?.state).toBe('failed');
  });

  it('worktrees list and clean (finished = merged or closed, nothing uncommitted; branches kept)', async () => {
    await setUp();
    await cli(['watch', '--once', '--ai-orchestrator'], { cwd: project.dir, exec: execWith(), api: watchApi() });
    const api = watchApi();
    const list = await cli(['worktrees'], { cwd: project.dir, exec: execWith(), api });
    expect(list.out).toMatch(/T1 +task\/T1 +.*0 commit\(s\)/);
    // No own commits = merged: clean removes the folder and keeps the branch.
    const clean = await cli(['worktrees', 'clean'], { cwd: project.dir, exec: execWith(), api });
    expect(clean.out).toContain('(merged; branch task/T1 kept)');
    expect(existsSync(worktreePath(project.dir, 'T1'))).toBe(false);
    expect(git(project.dir, 'branch', '--list', 'task/T1')).toContain('task/T1');
  });
});

describe('watch', () => {
  it('a restart does not repeat finished work; --retry runs it again', async () => {
    await setUp();
    await cli(['watch', '--once', '--ai-orchestrator'], { cwd: project.dir, exec: execWith(), api: watchApi() });
    const again = await cli(['watch', '--once', '--ai-orchestrator'], {
      cwd: project.dir,
      exec: execWith(),
      api: watchApi(),
    });
    expect(again.out).toContain('skipping T1 (ready before; run it again with: tossana-agents watch --retry T1)');
    const retry = await cli(['watch', '--once', '--ai-orchestrator', '--retry', 'T1'], {
      cwd: project.dir,
      exec: execWith(),
      api: watchApi(),
    });
    expect(retry.out).toContain('===== T1: Task T1 (new)');
  });

  it('resumes a task sent back with feedback: the comment is the top-priority instruction, handled once', async () => {
    await setUp();
    git(project.dir, 'branch', 'task/T2');
    git(project.dir, 'commit', '-q', '--allow-empty', '-m', 'main moves');
    const api = watchApi({ feedback: true });
    const r = await cli(['watch', '--once', '--ai-orchestrator'], { cwd: project.dir, exec: execWith(), api });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('T2 (feedback)');
    const prompt = readFileSync(join(worktreePath(project.dir, 'T2'), 'ran-here.txt'), 'utf8');
    expect(prompt).toContain('TOP PRIORITY');
    expect(prompt).toContain('Please make the button blue.');
    const started = api.calls.find((c) => c.method === 'POST' && c.path === '/v2/task/T2/comment')!.body as {
      comment_text: string;
    };
    expect(started.comment_text).toContain('[RESULT: STARTED] [ROUND: 2]');
    expect(started.comment_text).toContain("for the owner's feedback");
    expect(readFileSync(join(worktreePath(project.dir, 'T2'), '.agents/handoff/T2.md'), 'utf8')).toContain(
      'Owner feedback (top priority)',
    );
    expect(readWatchState(project.dir).tasks.T2?.feedbackId).toBe('5');
    const again = await cli(['watch', '--once', '--ai-orchestrator'], {
      cwd: project.dir,
      exec: execWith(),
      api: watchApi({ feedback: true }),
    });
    expect(again.out).not.toContain('T2 (feedback)');
  });

  it('does not start when doctor fails', async () => {
    await setUp();
    const api = watchApi().on(
      'GET /v2/user',
      () => new Response('{"err":"Token invalid","ECODE":"OAUTH_025"}', { status: 401 }),
    );
    const r = await cli(['watch', '--once', '--ai-orchestrator'], { cwd: project.dir, exec: execWith(), api });
    expect(r.code).toBe(1);
    expect(r.err).toContain('[watch] not started: fix the failed checks above first.');
    expect(existsSync(worktreePath(project.dir, 'T1'))).toBe(false);
  });

  it('parses intervals (at least one minute)', () => {
    expect(parseInterval('5m')).toBe(300_000);
    expect(parseInterval('90s')).toBe(90_000);
    expect(parseInterval('1h')).toBe(3_600_000);
    expect(() => parseInterval('10s')).toThrow('at least 1m');
    expect(() => parseInterval('soon')).toThrow('number with s, m or h');
  });
});

describe('feedback', () => {
  it('pending only after a finished pipeline, from people, and not once an agent answered', () => {
    expect(pendingFeedback([agent('1', 'orchestrator', 'PASS'), comment('2', 'Use blue.')])).toEqual({
      text: 'Use blue.',
      commentId: '2',
    });
    expect(pendingFeedback([agent('1', 'orchestrator', 'NEEDS_HUMAN'), comment('2', 'a'), comment('3', 'b')])).toEqual({
      text: 'a\n\nb',
      commentId: '3',
    });
    expect(pendingFeedback([agent('1', 'coder', 'DONE_CODING'), comment('2', 'mid-run note')])).toBeNull();
    expect(
      pendingFeedback([agent('1', 'orchestrator', 'PASS'), comment('2', 'x'), agent('3', 'orchestrator', 'STARTED')]),
    ).toBeNull();
    expect(pendingFeedback([comment('2', 'no pipeline yet')])).toBeNull();
  });

  it('feedback <taskId> "text" posts the comment, moves the task to coding and notes it in the handoff', async () => {
    await setUp();
    const api = fakeApi()
      .on('GET /v2/task/T2', {
        id: 'T2',
        name: 'x',
        status: { status: 'ready for review', type: 'custom' },
        list: { id: 'L1' },
      })
      .on('GET /v2/list/L1', LIST)
      .on('POST /v2/task/T2/comment', { id: '9' })
      .on('PUT /v2/task/T2', {});
    const r = await cli(['feedback', 'T2', 'Use', 'the', 'brand', 'blue'], { cwd: project.dir, exec: execWith(), api });
    expect(r.code, r.err).toBe(0);
    expect((api.calls.find((c) => c.method === 'POST')!.body as { comment_text: string }).comment_text).toBe(
      'Use the brand blue',
    );
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toEqual({ status: 'coding' });
    expect(readFileSync(join(project.dir, '.agents/handoff/T2.md'), 'utf8')).toContain('Owner feedback (top priority)');
    const fake = await cli(['feedback', 'T2', '[AGENT: coder] [RESULT: PASS]'], {
      cwd: project.dir,
      exec: execWith(),
      api,
    });
    expect(fake.err).toContain('your own words');
  });
});

describe('review (people only)', () => {
  it('refuses without an interactive terminal and inside an agent run', async () => {
    await setUp();
    expect((await cli(['review', 'T1'], { cwd: project.dir, exec: execWith() })).err).toContain('review is for people');
    const inAgent = await cli(['review', 'T1'], {
      cwd: project.dir,
      exec: execWith(),
      interactive: true,
      processEnv: { TOSSANA_AGENT: '1' },
    });
    expect(inAgent.err).toContain('review is for people');
  });
});

describe('notifications', () => {
  it('Windows: a fixed PowerShell script, the text only in environment variables', () => {
    const exec = execWith();
    notify(exec, 'win32', 'Ready: "x"; Remove-Item C:\\', 'T1 · done $(evil)');
    const call = exec.calls.at(-1)!;
    expect(call.cmd).toBe('powershell');
    expect(call.args.join(' ')).not.toContain('evil');
    expect(call.args.join(' ')).not.toContain('Remove-Item');
    expect(call.env).toEqual({
      TOSSANA_NOTIFY_TITLE: 'Ready: "x"; Remove-Item C:\\',
      TOSSANA_NOTIFY_TEXT: 'T1 · done $(evil)',
    });
  });

  it('macOS: osascript with the text as arguments', () => {
    const exec = execWith();
    notify(exec, 'darwin', 'Title', 'Text');
    expect(exec.calls.at(-1)).toMatchObject({ cmd: 'osascript', args: expect.arrayContaining(['Title', 'Text']) });
  });
});

describe('doctor: PowerShell execution policy (Windows, Antigravity)', () => {
  it('fails Restricted for the antigravity runner, with the fix', async () => {
    project = tempProject({ config: { ...CONFIG, tools: ['antigravity'], pipeline: { runner: 'antigravity' } } });
    const exec = execWith({
      'powershell -NoProfile -NonInteractive -Command Get-ExecutionPolicy': { stdout: 'Restricted\n' },
    });
    const d = await cli(['doctor'], { cwd: project.dir, exec, api: fakeApi(), platform: 'win32' });
    expect(d.out).toMatch(/(❌|\[FAIL\]) PowerShell can run scripts \(execution policy: Restricted\)/);
    expect(d.out).toContain('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned');
    expect(parseConfig(CONFIG)).toBeTruthy();
    expect(dirname(project.dir)).toBeTruthy();
  });
});
