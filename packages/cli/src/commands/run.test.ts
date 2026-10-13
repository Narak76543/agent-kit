import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exec } from '../exec.js';
import { RUN_LOCK } from '../run-lock.js';
import { customAdapter, formatCommand, splitCommand, taskPrompt } from '../runners.js';
import { CONFIG, TOKEN, cli, fakeApi, tempProject, type TempProject } from '../test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const git = (p: TempProject, ...args: string[]) => {
  const r = exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: p.dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** The fake agent: prints its argument (the prompt), a token-like secret split over two writes, and exits. */
const AGENT_SCRIPT = `
const prompt = process.argv[2];
process.stdout.write('agent got: ' + prompt + '\\n');
process.stdout.write('leaking pk_1234');
setTimeout(() => {
  process.stdout.write('5678_SECRETSECRET done\\n');
  process.stderr.write('warn line\\n');
  if (process.env.DIRTY) require('fs').writeFileSync('tracked.txt', 'changed');
}, 20);
`;

/** A git repo on main with the kit configured for the custom runner (node script). */
function gitProject(options: { runner?: string; agentCmd?: string } = {}) {
  const p = tempProject({
    config: { ...CONFIG, pipeline: { runner: options.runner ?? 'custom' } },
    env: `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\nAGENT_CMD=${options.agentCmd ?? 'node "fake agent/agent.js" {prompt}'}\n`,
  });
  p.write('fake agent/agent.js', AGENT_SCRIPT);
  p.write('.gitignore', '.env\n.agents/logs/\n.agents/handoff/\n');
  p.write('tracked.txt', 'v1');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'add', '-A');
  git(p, 'commit', '-q', '-m', 'init');
  return p;
}

const comments = [
  { id: '1', date: '1', comment_text: '[AGENT: orchestrator] [RESULT: STARTED] [ROUND: 1]\nSummary: go' },
  { id: '2', date: '2', comment_text: 'Human: looks fine' },
  { id: '3', date: '3', comment_text: '[AGENT: orchestrator] [RESULT: PASS] [ROUND: 2]\nSummary: done\nNext: human' },
];

const taskApi = (status: object = { status: 'to do', type: 'open' }) =>
  fakeApi()
    .on('GET /v2/task/T1', { id: 'T1', name: 'Login', status, list: { id: 'L1' } })
    .on('GET /v2/task/T1/comment', { comments: [...comments].reverse() });

const run = (p: TempProject, args: string[], api = taskApi()) => cli(['run', ...args], { cwd: p.dir, api, exec });

describe('run --dry-run', () => {
  it('prints the exact command and changes nothing (no ClickUp call, no git change)', async () => {
    project = gitProject({ runner: 'opencode' });
    const api = fakeApi();
    const r = await run(project, ['--task', 'T1', '--dry-run'], api);
    expect(r.code).toBe(0);
    expect(r.out).toContain('  git: create task/T1 from main');
    const args = ['run', '--agent', 'orchestrator', '--dir', project.dir, taskPrompt('T1')];
    expect(r.out).toContain(`  $ ${formatCommand({ cmd: 'opencode', args })}`);
    expect(api.calls).toHaveLength(0);
    expect(git(project, 'branch', '--show-current')).toBe('main');
  });

  it('shows the custom command with placeholders filled', async () => {
    project = gitProject();
    const r = await run(project, ['--task', 'T1', '--dry-run']);
    expect(r.out).toContain(`  $ node "fake agent/agent.js" "${taskPrompt('T1')}"`);
  });

  it('antigravity: shows the agy command, and what is missing on this machine', async () => {
    project = gitProject({ runner: 'antigravity' });
    const r = await run(project, ['--task', 'T1', '--dry-run']);
    expect(r.out).toContain(`  $ agy -p "${taskPrompt('T1')}" --agent orchestrator --print-timeout 120m`);
    expect(r.out).toContain('warning: this folder is not a trusted Antigravity workspace');
  });

  it('says when no agent would start', async () => {
    project = gitProject({ runner: 'opencode' });
    const r = await run(project, ['--task', 'T1', '--dry-run', '--no-agent']);
    expect(r.out).toContain('(no agent is started: --no-agent)');
  });
});

describe('run --task', () => {
  it('creates the branch, runs the agent, redacts the log and reports the last result', async () => {
    project = gitProject();
    const r = await run(project, ['--task', 'T1']);
    expect(r.err).not.toContain('ERROR');
    expect(r.code).toBe(0);
    expect(r.out).toContain('[run] on branch task/T1');
    expect(r.out).toContain(`agent got: ${taskPrompt('T1')}`);
    expect(r.out).toContain('leaking [REDACTED] done');
    expect(r.out + r.err).not.toContain('SECRETSECRET');
    expect(r.err).toContain('warn line');
    expect(r.out).toContain(
      'T1: agent exit 0, status "to do", last result orchestrator PASS (round 2), rounds used 2, branch task/T1',
    );
    expect(r.out).toContain('Nothing was pushed.');

    const logs = readdirSync(join(project.dir, '.agents', 'logs'));
    expect(logs).toEqual(['T1-2026-10-09T12-00-00-000Z.log']);
    const log = readFileSync(join(project.dir, '.agents', 'logs', logs[0]!), 'utf8');
    expect(log).toContain('agent got: Work on ClickUp task T1.');
    expect(log).toContain('leaking [REDACTED] done');
    expect(log).not.toContain('SECRETSECRET');

    // Back on the base branch, task branch kept.
    expect(git(project, 'branch', '--show-current')).toBe('main');
    expect(git(project, 'branch', '--list', 'task/T1')).toContain('task/T1');
  });

  it('reuses an existing task branch', async () => {
    project = gitProject();
    git(project, 'branch', 'task/T1');
    const r = await run(project, ['--task', 'T1', '--dry-run']);
    expect(r.out).toContain('git: switch to existing branch task/T1');
    expect((await run(project, ['--task', 'T1'])).code).toBe(0);
  });

  it('refuses to start with uncommitted changes to tracked files', async () => {
    project = gitProject();
    project.write('tracked.txt', 'dirty');
    const r = await run(project, ['--task', 'T1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('uncommitted changes; commit or stash them first');
    expect(r.err).toContain('tracked.txt');
  });

  it('stops when the agent leaves uncommitted changes', async () => {
    project = gitProject({ agentCmd: "node -e \"require('fs').writeFileSync('tracked.txt','x')\" {prompt}" });
    const r = await run(project, ['--task', 'T1']);
    expect(r.out).toContain('STOPPED: T1 left uncommitted changes on task/T1');
    expect(git(project, 'branch', '--show-current')).toBe('task/T1');
  });

  it('gives the agent the project folder as PWD, not the caller PWD (OpenCode prefers PWD)', async () => {
    project = gitProject({ agentCmd: 'node -e "console.log(\'pwd=\' + process.env.PWD)" {prompt}' });
    const r = await run(project, ['--task', 'T1']);
    expect(r.out).toContain(`pwd=${project.dir}`);
  });

  it('skips a closed task', async () => {
    project = gitProject();
    const r = await run(project, ['--task', 'T1'], taskApi({ status: 'complete', type: 'closed' }));
    expect(r.out).toContain('T1: skipped (task is closed: "complete")');
    expect(git(project, 'branch', '--show-current')).toBe('main');
  });

  it('--no-agent only prepares the branch', async () => {
    project = gitProject();
    const r = await run(project, ['--task', 'T1', '--no-agent']);
    expect(r.out).toContain('branch ready. Start the agent yourself');
    expect(r.out).not.toContain('agent got');
    expect(git(project, 'branch', '--show-current')).toBe('task/T1');
  });

  it('antigravity: stops before changing anything when agy would refuse the commands', async () => {
    project = gitProject({ runner: 'antigravity' });
    const r = await run(project, ['--task', 'T1']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('antigravity: this folder is not a trusted Antigravity workspace');
    expect(git(project, 'branch', '--show-current')).toBe('main');
  });

  it('explains a missing base branch', async () => {
    project = gitProject();
    project.write('agent.config.json', { ...CONFIG, pipeline: { runner: 'custom', baseBranch: 'develop' } });
    git(project, 'commit', '-q', '-am', 'config');
    const r = await run(project, ['--task', 'T1']);
    expect(r.err).toContain('could not switch to the base branch "develop"');
    expect(r.err).toContain('Set pipeline.baseBranch');
  });

  it('explains when OpenCode is not installed', async () => {
    project = gitProject({ runner: 'opencode' });
    const r = await cli(['run', '--task', 'T1'], {
      cwd: project.dir,
      api: taskApi(),
      exec: (cmd, args, o) =>
        cmd === 'opencode' ? { code: null, stdout: '', stderr: '', error: new Error('ENOENT') } : exec(cmd, args, o),
    });
    expect(r.err).toContain('opencode is not available. Install OpenCode: npm install -g opencode-ai');
  });

  it('rejects unsafe task IDs', async () => {
    project = gitProject();
    const r = await run(project, ['--task', '../x', '--dry-run']);
    expect(r.err).toContain('invalid task id "../x"');
  });
});

describe('run --next / --all', () => {
  const listApi = (tasks: object[]) =>
    fakeApi()
      .on('GET /v2/user', { user: { id: 777, username: 'me' } })
      .on('GET /v2/list/L1/task', { tasks, last_page: true });

  it('picks the oldest "todo" task assigned to me', async () => {
    project = gitProject();
    const api = listApi([
      { id: 'NEW', name: 'Newest' },
      { id: 'OLD', name: 'Oldest' },
    ]);
    const r = await run(project, ['--next', '--dry-run'], api);
    expect(r.out).toContain('===== OLD: Oldest =====');
    expect(r.out).not.toContain('NEW');
    const q = api.calls[1]!.query;
    expect(q.getAll('statuses[]')).toEqual(['to do']);
    expect(q.getAll('assignees[]')).toEqual(['777']);
  });

  it('lists every task with --all and says when there are none', async () => {
    project = gitProject();
    let r = await run(
      project,
      ['--all', '--dry-run'],
      listApi([
        { id: 'A', name: 'a' },
        { id: 'B', name: 'b' },
      ]),
    );
    expect(r.out.indexOf('===== B')).toBeLessThan(r.out.indexOf('===== A'));
    r = await run(project, ['--all'], listApi([]));
    expect(r.out).toContain('[run] no "to do" tasks assigned to you in list L1');
  });

  it('skips a task whose status changed after it was listed', async () => {
    project = gitProject();
    const api = listApi([{ id: 'T1', name: 'Login' }]).on('GET /v2/task/T1', {
      id: 'T1',
      name: 'Login',
      status: { status: 'coding', type: 'custom' },
    });
    const r = await run(project, ['--next'], api);
    expect(r.out).toContain('T1: skipped (status is now "coding")');
  });

  it('needs exactly one of --task, --next, --all', async () => {
    project = gitProject();
    expect((await run(project, [])).err).toContain('choose one');
    expect((await run(project, ['--task', 'T1', '--all'])).err).toContain('choose one');
  });
});

describe('runner helpers', () => {
  it('splits commands like a shell, keeping quoted words together', () => {
    expect(splitCommand(`opencode run --agent {agent} "{prompt}"`)).toEqual([
      'opencode',
      'run',
      '--agent',
      '{agent}',
      '{prompt}',
    ]);
    expect(splitCommand(`node 'C:\\My Tools\\agent.js' --x=""  a`)).toEqual([
      'node',
      'C:\\My Tools\\agent.js',
      '--x=',
      'a',
    ]);
    expect(() => splitCommand('node "oops')).toThrow('unclosed quote');
  });

  it('keeps the old EKMONG_MOBILE AGENT_CMD working ({taskId})', () => {
    const adapter = customAdapter(
      'opencode run --auto --agent orchestrator "Run ClickUp task {taskId}. Follow AGENTS.md and your agent instructions."',
      '86abc123',
    );
    expect(adapter.buildCommand({ agent: 'orchestrator', prompt: 'p', cwd: '.' })).toEqual({
      cmd: 'opencode',
      args: [
        'run',
        '--auto',
        '--agent',
        'orchestrator',
        'Run ClickUp task 86abc123. Follow AGENTS.md and your agent instructions.',
      ],
    });
  });

  it('fills a prompt with quotes as one argument', () => {
    const adapter = customAdapter('tool {agent} {prompt}', 'T1');
    expect(adapter.buildCommand({ agent: 'orchestrator', prompt: 'say "hi" & bye', cwd: '.' }).args).toEqual([
      'orchestrator',
      'say "hi" & bye',
    ]);
  });

  it('rejects an AGENT_CMD without a prompt', () => {
    expect(() => customAdapter('opencode run', 'T1').buildCommand({ agent: 'a', prompt: 'p', cwd: '.' })).toThrow(
      'must contain {prompt}',
    );
    expect(() => customAdapter('', 'T1').buildCommand({ agent: 'a', prompt: 'p', cwd: '.' })).toThrow(
      'AGENT_CMD is empty',
    );
  });

  it('formats commands for display', () => {
    expect(formatCommand({ cmd: 'opencode', args: ['run', 'a b', 'say "x"', 'C:\\x\\y.js'] })).toBe(
      'opencode run "a b" "say \\"x\\"" C:\\x\\y.js',
    );
  });
});

describe('run: one run per project', () => {
  it('refuses to start while another run holds the lock, and takes over a stale lock', async () => {
    project = gitProject();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      project.write(RUN_LOCK, JSON.stringify({ pid: other.pid, task: 'T9', startedAt: '2026-10-13T08:00:00Z' }));
      const busy = await run(project, ['--task', 'T1']);
      expect(busy.code).not.toBe(0);
      expect(busy.err).toContain(`another run is already going in this project (pid ${other.pid}, task T9`);
      expect(git(project, 'branch', '--show-current')).toBe('main');
      // A dry run changes nothing, so it does not need the lock.
      expect((await run(project, ['--task', 'T1', '--dry-run'])).code).toBe(0);
    } finally {
      other.kill();
    }

    project.write(RUN_LOCK, JSON.stringify({ pid: 2 ** 30 }));
    const r = await run(project, ['--task', 'T1']);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(project.dir, RUN_LOCK))).toBe(false);
  });
});
