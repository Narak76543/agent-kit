/** The live agy agent check ("reply pong"), with a fake agy: the real one is never started in tests. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentAgyCheck, readAgyCheck, runAgyCheck } from './agy-check.js';
import { addAntigravityRules, antigravityRules } from './antigravity.js';
import { exec as realExec, type Exec, type ExecResult } from './exec.js';
import { parseConfig } from '@tossana/agents-core';
import { CONFIG, cli, fakeApi, tempProject, type TempProject } from './test-utils.test-helper.js';

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

interface AgyCall {
  agent: string;
  /** The agent file agy would load (for subagent copies: the temporary copy). */
  file: string | null;
}

/**
 * A fake agy 1.3.3: answers "pong", or the registry error when the agent's tools list a name in `unknown`.
 * git runs for real (run tests need a repository).
 */
function fakeAgy(options: { version?: string; unknown?: string[] } = {}): Exec & { calls: AgyCall[] } {
  const calls: AgyCall[] = [];
  const run = ((cmd: string, args: string[], o?: { cwd?: string; timeoutMs?: number }): ExecResult => {
    if (cmd === 'git') return realExec(cmd, args, o);
    if (cmd !== 'agy') return { code: null, stdout: '', stderr: '', error: new Error(`spawn ${cmd} ENOENT`) };
    if (args[0] === '--version') return { code: 0, stdout: `${options.version ?? '1.3.3'}\n`, stderr: '' };
    const agent = args[args.indexOf('--agent') + 1]!;
    const addDir = args.includes('--add-dir') ? args[args.indexOf('--add-dir') + 1]! : null;
    const file = addDir
      ? join(addDir, '.agents', 'agents', agent, 'agent.md')
      : join(o!.cwd!, '.agents', 'agents', agent, 'agent.md');
    const text = readFileSync(file, 'utf8');
    calls.push({ agent, file: text });
    const bad = (options.unknown ?? []).find((t) => new RegExp(`^  - ${t}$`, 'm').test(text));
    if (bad) {
      return {
        code: 1,
        stdout: '',
        stderr: `error: failed to construct executor: failed to resolve components: unknown component: tool "${bad}" not found in registry\n`,
      };
    }
    return { code: 0, stdout: 'pong\n', stderr: '' };
  }) as Exec & { calls: AgyCall[] };
  run.calls = calls;
  return run;
}

/** A kit project with the Antigravity agents, trusted, with the permission rules allowed. */
async function antigravityProject(runner = 'antigravity') {
  project = tempProject({ config: { ...CONFIG, tools: ['opencode', 'antigravity'], pipeline: { runner } } });
  project.write('package.json', '{}');
  project.write('.gitignore', '.env\n.agents/logs/\n.agents/handoff/\n.tossana/tmp/\n');
  const r = await cli(['init', '--yes', '--no-doctor'], {
    cwd: project.dir,
    api: fakeApi().on('GET /v2/list/L1', LIST),
  });
  expect(r.code, r.err).toBe(0);
  const home = join(dirname(project.dir), 'home');
  project.write('../home/.gemini/antigravity-cli/settings.json', { trustedWorkspaces: [project.dir] });
  addAntigravityRules(
    home,
    antigravityRules(parseConfig({ ...CONFIG, tools: ['opencode', 'antigravity'] }), 'npx tossana-agents'),
  );
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'init'],
  ]) {
    realExec('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { cwd: project.dir });
  }
}

const check = (exec: Exec) => cli(['antigravity', 'check'], { cwd: project.dir, exec });

describe('antigravity check', () => {
  it('starts every agent once with "pong", each as a main-agent copy with the same tools and a trivial body', async () => {
    await antigravityProject();
    const agy = fakeAgy();
    const r = await check(agy);
    expect(r.code, r.err).toBe(0);
    expect(agy.calls.map((c) => c.agent)).toEqual([
      'zz-tossana-check-orchestrator',
      'zz-tossana-check-coder',
      'zz-tossana-check-reviewer',
      'zz-tossana-check-tester',
    ]);
    expect(r.out).toContain('✓ coder: pong');
    // The copy keeps the tools and settings, and is a main agent.
    const coderCopy = agy.calls[1]!.file!;
    const coder = readFileSync(join(project.dir, '.agents/agents/coder/agent.md'), 'utf8');
    for (const tool of coder.match(/^ {2}- \w+$/gm)!) expect(coderCopy).toContain(tool);
    expect(coderCopy).toMatch(/^mainAgent: true$/m);
    expect(coderCopy).toMatch(/^commandExecutionPolicy: auto$/m);
    // The orchestrator copy keeps its tools (invoke_subagent) but not its procedure.
    expect(agy.calls[0]!.file).toContain('  - invoke_subagent');
    expect(agy.calls[0]!.file).not.toContain('start-task');
    expect(readAgyCheck(project.dir)?.agents.every((a) => a.ok)).toBe(true);
  });

  it('names the agent and the tool agy does not know, and remembers nothing', async () => {
    await antigravityProject();
    const r = await check(fakeAgy({ unknown: ['multi_replace_file_content'] }));
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      '✗ coder: agy does not know the tool "multi_replace_file_content" (in .agents/agents/coder/agent.md)',
    );
    expect(r.out).toContain('✓ reviewer: pong');
    expect(readAgyCheck(project.dir)).toBeNull();
  });

  it('the kit agents use no tool agy 1.3.3 rejects', async () => {
    await antigravityProject();
    const rejected = [
      'command_status',
      'send_command_input',
      'read_terminal',
      'list_directory',
      'view_file_outline',
      'view_code_item',
      'codebase_search',
      'code_search',
      'notify_user',
    ];
    const r = await check(fakeAgy({ unknown: rejected }));
    expect(r.code, r.out).toBe(0);
  });

  it('a remembered result is stale after an agy upgrade or an agent file change', async () => {
    await antigravityProject();
    await check(fakeAgy());
    const ctx = (version: string) => ({ exec: fakeAgy({ version }), cwd: project.dir, now: () => new Date() });
    expect(currentAgyCheck(ctx('1.3.3'))).not.toBeNull();
    expect(currentAgyCheck(ctx('1.4.0'))).toBeNull();
    const file = join(project.dir, '.agents/agents/tester/agent.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
    expect(currentAgyCheck(ctx('1.3.3'))).toBeNull();
    expect(runAgyCheck(ctx('1.3.3')).agents).toHaveLength(4);
  });
});

describe('run --runner antigravity checks the agents first', () => {
  it('stops before any change when an agent cannot start', async () => {
    await antigravityProject();
    const agy = fakeAgy({ unknown: ['command_status'] });
    // An older kit file with the bad tool, as in the real failure.
    const orch = join(project.dir, '.agents/agents/orchestrator/agent.md');
    writeFileSync(
      orch,
      readFileSync(orch, 'utf8').replace('  - run_command\n', '  - run_command\n  - command_status\n'),
    );
    const api = fakeApi().on('GET /v2/task/T1', {
      id: 'T1',
      name: 'x',
      status: { status: 'to do', type: 'open' },
      list: { id: 'L1' },
    });
    const r = await cli(['run', '--task', 'T1'], { cwd: project.dir, api, exec: agy });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('agy cannot start these agents: orchestrator: agy does not know the tool "command_status"');
    expect(realExec('git', ['branch', '--show-current'], { cwd: project.dir }).stdout.trim()).toBe('main');
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('dry run: says the check is still to do, without starting agy for a model call', async () => {
    await antigravityProject();
    const agy = fakeAgy();
    const r = await cli(['run', '--task', 'T1', '--dry-run'], { cwd: project.dir, exec: agy });
    expect(r.out).toContain('warning: the agents are not checked with this agy version yet');
    expect(agy.calls).toHaveLength(0);
  });

  it('doctor shows the remembered check', async () => {
    await antigravityProject();
    const agy = fakeAgy();
    const before = await cli(['doctor'], { cwd: project.dir, exec: agy, api: fakeApi() });
    expect(before.out).toMatch(/(⚠️|\[WARN\]) +Antigravity starts every agent/);
    expect(agy.calls).toHaveLength(0);
    await check(agy);
    const after = await cli(['doctor'], { cwd: project.dir, exec: agy, api: fakeApi() });
    expect(after.out).toMatch(/(✅|\[ OK \]) Antigravity starts every agent \(checked \d{4}-\d\d-\d\d, agy 1\.3\.3\)/);
  });
});
