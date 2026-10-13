import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../context.js';
import { fakeExec } from '../test-utils.test-helper.js';
import { followLogs, splitPlan } from './follow.js';

let dir: string;
let logs: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tak follow '));
  logs = join(dir, '.agents', 'logs', 'T1');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Not a git repository: the main folder is the folder itself. */
const ctxWith = (out: { text: string }, extra: Parameters<typeof createContext>[0] = {}) =>
  createContext({
    cwd: dir,
    exec: fakeExec({ 'git rev-parse': { code: 128 } }),
    io: { out: (t) => (out.text += t), err: (t) => (out.text += t) },
    ...extra,
  });

const write = (file: string, text: string) => {
  mkdirSync(logs, { recursive: true });
  appendFileSync(join(logs, file), text);
};

/** Runs follow while `steps` append to the logs, one step per poll. */
async function followWhile(opts: { role?: string }, steps: (() => void)[]) {
  const out = { text: '' };
  const done = followLogs(ctxWith(out), 'T1', opts, { intervalMs: 5 });
  for (const step of steps) {
    await new Promise((r) => setTimeout(r, 15));
    step();
  }
  await done;
  return out.text;
}

describe('follow', () => {
  it('without --role: the kit and every role, prefixed, until FINISHED (waits for the run to start)', async () => {
    const out = await followWhile({}, [
      () => write('pipeline.log', '10:00:00 === RUN T1: round 1\n10:00:01 round 1: coder started\n'),
      () => write('1-coder.log', '$ agy -p …\n→ run_command git status\n'),
      () => write('1-coder.log', 'half a li'),
      () => write('1-coder.log', 'ne\n'),
      () => write('1-reviewer.log', 'reading the diff\n'),
      () => write('pipeline.log', '10:05:00 === FINISHED PASS (round 1): ok\n'),
    ]);
    expect(out).toContain('[follow] no run of T1 yet; waiting for it to start');
    expect(out).toContain('[kit] 10:00:01 round 1: coder started\n');
    expect(out).toContain('[r1 coder] → run_command git status\n');
    expect(out).toContain('[r1 coder] half a line\n');
    expect(out).toContain('[r1 reviewer] reading the diff\n');
    expect(out.trim().split('\n').at(-1)).toBe('[follow] T1: the pipeline finished.');
  });

  it('--role: only that role, switching to the next round by itself', async () => {
    write('pipeline.log', '=== RUN T1: round 1\n');
    write('1-coder.log', 'coder round 1\n');
    write('1-reviewer.log', 'not shown\n');
    const out = await followWhile({ role: 'coder' }, [
      () => write('2-coder.log', 'coder round 2\n'),
      () => write('pipeline.log', '=== FINISHED NEEDS_HUMAN (round 2): x\n'),
    ]);
    expect(out).toContain('── round 1 · coder ──\ncoder round 1\n');
    expect(out).toContain('── round 2 · coder ──\ncoder round 2\n');
    expect(out).not.toContain('not shown');
    expect(out).not.toContain('[kit]');
  });

  it('a task whose last run finished: shows it and ends; a resumed run (new RUN line) is followed again', async () => {
    write('pipeline.log', '=== RUN T1\n=== FINISHED PASS\n');
    const out = { text: '' };
    await followLogs(ctxWith(out), 'T1', {}, { intervalMs: 5 });
    expect(out.text).toContain('the last run of T1 has finished');

    write('pipeline.log', '=== RUN T1: round 2\n');
    const again = await followWhile({}, [() => write('pipeline.log', '=== FINISHED STOPPED\n')]);
    expect(again).toContain('[kit] === FINISHED STOPPED');
    expect(again).toContain('[follow] T1: the pipeline finished.');
  });

  it('refuses bad task ids and role names', async () => {
    await expect(followLogs(ctxWith({ text: '' }), '../x', {})).rejects.toThrow('invalid task id');
    await expect(followLogs(ctxWith({ text: '' }), 'T1', { role: 'Coder;rm' })).rejects.toThrow('invalid role');
  });
});

describe('follow --split', () => {
  const roles = ['coder', 'reviewer', 'tester'];
  const plan = (platform: NodeJS.Platform, env: Record<string, string>) =>
    splitPlan(ctxWith({ text: '' }, { platform, processEnv: env }), 'T1', roles);

  it('macOS Terminal: one window per role, each command an osascript argument', () => {
    const p = plan('darwin', { TERM_PROGRAM: 'Apple_Terminal' });
    expect(p.terminal).toBe('terminal');
    expect(p.launch!.cmd).toBe('osascript');
    expect(p.launch!.args[1]).toContain('do script (c as text)');
    expect(p.launch!.args.slice(2)).toEqual(roles.map((r) => `cd '${dir}' && tossana-agents follow T1 --role ${r}`));
  });

  it('iTerm2: panes in one window', () => {
    const p = plan('darwin', { TERM_PROGRAM: 'iTerm.app' });
    expect(p.terminal).toBe('iterm');
    expect(p.launch!.args[1]).toContain('split vertically with default profile');
  });

  it('quotes the folder for the shell (a single quote in the path)', () => {
    const odd = join(dir, "it's");
    mkdirSync(odd);
    const p = splitPlan(createContext({ cwd: odd, platform: 'darwin', processEnv: {} }), 'T1', ['coder']);
    expect(p.launch!.args[2]).toBe(`cd '${odd.replace("'", `'\\''`)}' && tossana-agents follow T1 --role coder`);
  });

  it('Windows Terminal: a new tab, then split panes, each running follow in cmd /k', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    const p = plan('win32', { WT_SESSION: 'abc' });
    expect(p.terminal).toBe('windows-terminal');
    expect(p.launch).toEqual({
      cmd: 'wt',
      args: [
        '-w',
        '0',
        'new-tab',
        '-d',
        dir,
        '--title',
        'coder',
        'cmd',
        '/k',
        'npx',
        'tossana-agents',
        'follow',
        'T1',
        '--role',
        'coder',
        ';',
        'split-pane',
        '-V',
        '-d',
        dir,
        '--title',
        'reviewer',
        'cmd',
        '/k',
        'npx',
        'tossana-agents',
        'follow',
        'T1',
        '--role',
        'reviewer',
        ';',
        'split-pane',
        '-H',
        '-d',
        dir,
        '--title',
        'tester',
        'cmd',
        '/k',
        'npx',
        'tossana-agents',
        'follow',
        'T1',
        '--role',
        'tester',
      ],
    });
  });

  it('anywhere else (Linux, Windows outside Windows Terminal): only the commands', () => {
    expect(plan('linux', {})).toMatchObject({ terminal: 'none', launch: null });
    expect(plan('win32', {}).commands).toEqual(roles.map((r) => `tossana-agents follow T1 --role ${r}`));
  });
});
