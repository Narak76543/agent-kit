import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAgentComment, parseConfig } from '@tossana/agents-core';
import { rulesFile } from '../codex.js';
import { exec } from '../exec.js';
import type { Prompts } from '../prompts.js';
import { CONFIG, TOKEN, cli, fakeApi, tempProject, type TempProject } from '../test-utils.test-helper.js';
import { previousTool } from './resume.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const git = (p: TempProject, ...args: string[]) => {
  const r = exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: p.dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const read = (file: string) => readFileSync(join(project.dir, ...file.split('/')), 'utf8');

/** Prints the prompt it was given, like the fake agent in run.test.ts. */
const AGENT = `process.stdout.write('agent got: ' + process.argv[2] + '\\n');`;

/** A project whose task T1 was started with OpenCode and is now on its branch with one commit. */
function startedProject(options: { tools?: string[] } = {}) {
  const p = tempProject({
    config: { ...CONFIG, tools: options.tools ?? ['opencode'], pipeline: { runner: 'opencode' } },
    env: `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\nAGENT_CMD=node "fake agent/agent.js" {prompt}\n`,
  });
  p.write('fake agent/agent.js', AGENT);
  p.write('.gitignore', '.env\n.agents/logs/\n.agents/handoff/\n.tossana/tmp/\n');
  p.write('.opencode/agents/orchestrator.md', 'x');
  p.write('app.ts', 'v1');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'add', '-A');
  git(p, 'commit', '-q', '-m', 'init');
  git(p, 'switch', '-q', '-c', 'task/T1');
  p.write('app.ts', 'v2');
  git(p, 'commit', '-q', '-am', 'T1: coder round 1');
  p.write(
    '.agents/handoff/T1.md',
    '# Handoff log for task T1\n\n## 2026-10-12T10:00:00.000Z — Run started with opencode\n\nTool: opencode.\n',
  );
  git(p, 'switch', '-q', 'main');
  return p;
}

const COMMENTS = [
  { id: '1', date: '1', comment_text: '[AGENT: orchestrator] [RESULT: STARTED] [ROUND: 1]\nSummary: go\nNext: coder' },
  {
    id: '2',
    date: '2',
    comment_text: '[AGENT: reviewer] [RESULT: CHANGES_NEEDED] [ROUND: 2]\nSummary: x\nNext: coder',
  },
];

function taskApi(status: object = { status: 'in review', type: 'custom' }) {
  const api = fakeApi()
    .on('GET /v2/task/T1', { id: 'T1', name: 'Login', status, list: { id: 'L1' } })
    .on('GET /v2/task/T1/comment', { comments: [...COMMENTS].reverse() })
    .on('POST /v2/task/T1/comment', { id: 99 });
  return api;
}

const resume = (args: string[], api = taskApi(), opts: { prompts?: Prompts; interactive?: boolean } = {}) =>
  cli(['run', '--ai-orchestrator', '--task', 'T1', '--resume', '--runner', 'custom', ...args], {
    cwd: project.dir,
    api,
    exec,
    prompts: opts.prompts,
    interactive: opts.interactive,
  });

const posted = (api: ReturnType<typeof fakeApi>) =>
  api.calls.filter((c) => c.method === 'POST').map((c) => (c.body as { comment_text: string }).comment_text);

describe('run --resume', () => {
  it('continues a task in review on its own branch, posts the switch and tells the agent not to restart', async () => {
    project = startedProject();
    const api = taskApi();
    const r = await resume([], api);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);

    const [comment] = posted(api);
    expect(parseAgentComment(comment!)).toMatchObject({
      agent: 'orchestrator',
      result: 'STARTED',
      round: 2,
      next: 'coder',
    });
    expect(comment).toContain(
      'Resumed with custom after opencode. Branch task/T1, continuing round 2 (last: reviewer CHANGES_NEEDED)',
    );

    expect(r.out).toContain('agent got: Resume ClickUp task T1; it was being worked on with opencode. Do not restart');
    expect(r.out).toContain(
      'If the last turn has no agent comment (the tool stopped mid-turn), treat that turn as unfinished',
    );
    // The branch is kept: the earlier commit is still there, nothing was reset.
    expect(git(project, 'log', '--format=%s', 'task/T1')).toContain('T1: coder round 1');
    expect(read('.agents/handoff/T1.md')).toMatch(/— Resumed with custom after opencode/);
    expect(previousTool(read('.agents/handoff/T1.md'))).toBe('custom');
  });

  it.each([
    [{ status: 'ready for review', type: 'custom' }, 'waiting for a human'],
    [{ status: 'complete', type: 'closed' }, 'is closed'],
    [{ status: 'blocked', type: 'custom' }, 'not an agent status'],
  ])('never touches a task in a human, closed or unknown status (%o)', async (status, message) => {
    project = startedProject();
    const api = taskApi(status);
    const r = await resume([], api);
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(posted(api)).toHaveLength(0);
    expect(git(project, 'branch', '--show-current')).toBe('main');
  });

  it('stops on uncommitted changes in a non-interactive run, commits them as WIP with --yes', async () => {
    project = startedProject();
    git(project, 'switch', '-q', 'task/T1');
    project.write('app.ts', 'half-done by the previous tool');
    project.write('new-file.ts', 'new');

    let r = await resume([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('task/T1 has uncommitted changes from opencode');
    expect(r.err).toContain('run again with --yes to commit them as "WIP: handoff from opencode"');

    r = await resume(['--yes']);
    expect(r.code).toBe(0);
    expect(git(project, 'log', '-1', '--format=%s', 'task/T1')).toBe('WIP: handoff from opencode');
    expect(git(project, 'show', '--name-only', '--format=', 'task/T1')).toContain('new-file.ts');
  });

  it('asks before committing leftover changes in a terminal (and stops on no)', async () => {
    project = startedProject();
    git(project, 'switch', '-q', 'task/T1');
    project.write('app.ts', 'half-done');
    const asked: string[] = [];
    const prompts = (answer: boolean) =>
      ({
        confirm: async (m: string) => {
          asked.push(m);
          return answer;
        },
      }) as unknown as Prompts;

    let r = await resume([], taskApi(), { prompts: prompts(false), interactive: true });
    expect(r.code).toBe(1);
    expect(asked[0]).toContain('Commit them as "WIP: handoff from opencode"?');
    r = await resume([], taskApi(), { prompts: prompts(true), interactive: true });
    expect(r.code).toBe(0);
    expect(git(project, 'log', '-1', '--format=%s', 'task/T1')).toBe('WIP: handoff from opencode');
  });

  it('refuses a tool whose files are missing and says how to add it', async () => {
    project = startedProject();
    const r = await cli(['run', '--ai-orchestrator', '--task', 'T1', '--resume', '--runner', 'codex'], {
      cwd: project.dir,
      api: taskApi(),
      exec,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('codex is not set up in this project (.codex/orchestrator.md is missing)');
    expect(r.err).toContain('tossana-agents init --yes --tools opencode,codex');
  });

  it('refuses when there is no task branch to resume', async () => {
    project = startedProject();
    git(project, 'branch', '-D', 'task/T1');
    const r = await resume([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('nothing to resume: there is no branch task/T1');
  });

  it('prints the plan in a dry run without calling ClickUp', async () => {
    project = startedProject();
    const api = fakeApi();
    const r = await resume(['--dry-run'], api);
    expect(r.code).toBe(0);
    expect(r.out).toContain('resume T1 with custom (previous: opencode)');
    expect(r.out).toContain('Resumed with custom after opencode');
    expect(api.calls).toHaveLength(0);
  });

  it('a normal run records the tool in the handoff file, so a later resume can name it', async () => {
    project = startedProject();
    git(project, 'branch', '-D', 'task/T1');
    const r = await cli(['run', '--ai-orchestrator', '--task', 'T1', '--runner', 'custom'], {
      cwd: project.dir,
      api: taskApi({ status: 'to do', type: 'open' }),
      exec,
    });
    expect(r.code).toBe(0);
    expect(previousTool(read('.agents/handoff/T1.md'))).toBe('custom');
  });

  it('Codex: handoff notes are written by the kit command, which the rules run outside the read-only sandbox', () => {
    const rules = rulesFile(parseConfig(CONFIG), '# h');
    expect(rules).toContain('pattern = ["tossana-agents", "clickup"],\n    decision = "allow"');
    expect(rules).toContain('"tossana-agents clickup handoff T1 --file .tossana/tmp/T1-coder.md"');
  });
});
