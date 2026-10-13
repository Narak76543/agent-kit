/**
 * `tossana-agents follow <taskId> [--role <role>] [--split]`: watch the agents of a task live, from the logs the kit's
 * pipeline writes (agent-logs.ts). Works from the main folder or any task worktree.
 *
 * - Without --role: everything, prefixed: `[kit]` (pipeline.log) and `[r<round> <role>]` (each role's log).
 * - With --role: only that role, round after round (it switches to the next round's file when it appears).
 * - Waits for the logs to appear; stops at the pipeline's FINISHED line. A task that already finished is shown and
 *   follow ends.
 * - --split: one terminal per role: panes in iTerm2 and Windows Terminal, windows in macOS Terminal; anywhere else
 *   it prints the commands to run. Values are passed as arguments, never pasted into a script.
 * The files are polled (fs.watch is unreliable on Windows and on network drives).
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { KitError, ROLE_NAME, isValidTaskId, pipelineRoles } from '@tossana/agents-core';
import { FINISHED_MARK, PIPELINE_LOG, RUN_MARK, mainFolder, roleLogs, taskLogDir } from '../agent-logs.js';
import { kitCommand } from '../antigravity.js';
import { loadProject, requireConfig, type CliContext } from '../context.js';

export interface FollowOptions {
  role?: string;
  split?: boolean;
}

export function registerFollowCommand(program: Command, ctx: CliContext): void {
  program
    .command('follow <taskId>')
    .description("watch a task's agents live: all of them, one role (--role), or one terminal per role (--split)")
    .option('--role <role>', 'only this role, e.g. coder, reviewer or tester')
    .option('--split', 'open one terminal per role (iTerm2, Windows Terminal; windows in macOS Terminal)')
    .action((taskId: string, opts: FollowOptions) =>
      opts.split ? splitFollow(ctx, taskId) : followLogs(ctx, taskId, opts),
    );
}

/** Reads a file from an offset: only complete lines; a shorter file (rewritten) starts again from the top. */
class Tail {
  private offset = 0;
  private rest = Buffer.alloc(0);
  constructor(readonly path: string) {}

  read(): string[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.path, 'r');
    try {
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const all = Buffer.concat([this.rest, buf]);
    const end = all.lastIndexOf(0x0a);
    if (end < 0) {
      this.rest = all;
      return [];
    }
    this.rest = all.subarray(end + 1);
    return all
      .subarray(0, end)
      .toString('utf8')
      .split('\n')
      .map((l) => l.replace(/\r$/, ''));
  }

  /** What is left without a newline (the file is done). */
  flush(): string[] {
    const text = this.rest.toString('utf8');
    this.rest = Buffer.alloc(0);
    return text ? [text] : [];
  }
}

/** The last RUN or FINISHED marker decides whether the pipeline is still going. */
const finishedIn = (lines: string[], current: boolean) =>
  lines.reduce((done, l) => (l.includes(FINISHED_MARK) ? true : l.includes(RUN_MARK) ? false : done), current);

export async function followLogs(
  ctx: CliContext,
  taskId: string,
  opts: FollowOptions,
  poll: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  if (!isValidTaskId(taskId)) throw new KitError(`invalid task id "${taskId}"`);
  if (opts.role !== undefined && !ROLE_NAME.test(opts.role)) throw new KitError(`invalid role "${opts.role}"`);
  const dir = taskLogDir(mainFolder(ctx.exec, ctx.cwd), taskId);
  const print = (s: string) => ctx.io.out(`${s}\n`);
  const intervalMs = poll.intervalMs ?? 500;

  const pipeline = new Tail(join(dir, PIPELINE_LOG));
  const tails = new Map<string, { tail: Tail; prefix: string }>();
  let finished = false;
  let waiting = false;
  let firstRead = true;
  let lastFile: string | null = null;

  print(
    `[follow] ${taskId}${opts.role ? `, ${opts.role}` : ''}: ${dir}` +
      (opts.role ? '' : `\n[follow] one role only: tossana-agents follow ${taskId} --role <role>`),
  );
  for (;;) {
    if (poll.signal?.aborted) return;
    const kit = pipeline.read();
    const wasFinished = finished;
    finished = finishedIn(kit, finished);
    if (!opts.role) for (const l of kit) print(`[kit] ${l}`);

    for (const log of roleLogs(dir)) {
      if (opts.role && log.role !== opts.role) continue;
      let entry = tails.get(log.file);
      if (!entry) {
        entry = { tail: new Tail(join(dir, log.file)), prefix: opts.role ? '' : `[r${log.round} ${log.role}] ` };
        tails.set(log.file, entry);
      }
      const lines = entry.tail.read();
      if (!lines.length) continue;
      if (opts.role) {
        if (lastFile !== log.file) print(`\n── round ${log.round} · ${log.role} ──`);
        lastFile = log.file;
        for (const l of lines) print(l);
      } else {
        for (const l of lines) print(`${entry.prefix}${l}`);
      }
    }

    if (finished) {
      for (const { tail, prefix } of tails.values()) for (const l of tail.flush()) print(`${prefix}${l}`);
      print(
        firstRead || wasFinished
          ? `[follow] the last run of ${taskId} has finished. Start or resume it, then follow again.`
          : `[follow] ${taskId}: the pipeline finished.`,
      );
      return;
    }
    if (firstRead && !existsSync(join(dir, PIPELINE_LOG)) && !waiting) {
      print(`[follow] no run of ${taskId} yet; waiting for it to start (Ctrl+C stops)…`);
      waiting = true;
    }
    firstRead = false;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      poll.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}

// ---------- --split ----------

/** Single-quotes a word for a POSIX shell. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** iTerm2: a new window, one vertical pane per command (each command is one argument). */
const ITERM_SCRIPT = `on run argv
  tell application "iTerm2"
    activate
    set w to (create window with default profile)
    set s to current session of w
    tell s to write text (item 1 of argv)
    repeat with i from 2 to (count of argv)
      tell s to set s to (split vertically with default profile)
      tell s to write text (item i of argv)
    end repeat
  end tell
end run`;

/** macOS Terminal cannot split panes from AppleScript: one window per command. */
const TERMINAL_SCRIPT = `on run argv
  tell application "Terminal"
    activate
    repeat with c in argv
      do script (c as text)
    end repeat
  end tell
end run`;

export interface SplitPlan {
  terminal: 'iterm' | 'terminal' | 'windows-terminal' | 'none';
  /** The program and its arguments, or null when the commands are only printed. */
  launch: { cmd: string; args: string[] } | null;
  /** One follow command per role, for display. */
  commands: string[];
}

/** What --split would open on this machine. */
export function splitPlan(ctx: CliContext, taskId: string, roles: string[]): SplitPlan {
  const kit = kitCommand(ctx.cwd);
  const follow = (role: string) => `${kit} follow ${taskId} --role ${role}`;
  const commands = roles.map(follow);
  const env = ctx.processEnv;
  if (ctx.platform === 'darwin') {
    const lines = roles.map((r) => `cd ${sh(ctx.cwd)} && ${follow(r)}`);
    if (env.TERM_PROGRAM === 'iTerm.app') {
      return { terminal: 'iterm', launch: { cmd: 'osascript', args: ['-e', ITERM_SCRIPT, ...lines] }, commands };
    }
    return { terminal: 'terminal', launch: { cmd: 'osascript', args: ['-e', TERMINAL_SCRIPT, ...lines] }, commands };
  }
  if (ctx.platform === 'win32' && env.WT_SESSION) {
    // wt: `new-tab` then `split-pane` per role, separated by a ";" argument. cmd /k keeps the pane open at the end
    // (npm commands are .cmd shims, which wt cannot start by themselves).
    const args = ['-w', '0'];
    roles.forEach((role, i) => {
      if (i) args.push(';', 'split-pane', i === 1 ? '-V' : '-H');
      else args.push('new-tab');
      args.push('-d', ctx.cwd, '--title', role, 'cmd', '/k', ...follow(role).split(' '));
    });
    return { terminal: 'windows-terminal', launch: { cmd: 'wt', args }, commands };
  }
  return { terminal: 'none', launch: null, commands };
}

export function splitFollow(ctx: CliContext, taskId: string): void {
  if (!isValidTaskId(taskId)) throw new KitError(`invalid task id "${taskId}"`);
  const roles = pipelineRoles(requireConfig(loadProject(ctx))).map((r) => r.name);
  const plan = splitPlan(ctx, taskId, roles);
  const printCommands = (why: string) => {
    ctx.logger.info(`[follow] ${why}. Run each of these in its own terminal, in ${ctx.cwd}:`);
    for (const c of plan.commands) ctx.logger.info(`  ${c}`);
    ctx.logger.info(`  (or everything in one: tossana-agents follow ${taskId})`);
  };
  if (!plan.launch) {
    printCommands(
      ctx.platform === 'win32'
        ? 'not inside Windows Terminal (WT_SESSION is not set)'
        : 'this terminal cannot be split automatically',
    );
    return;
  }
  const r = ctx.exec(plan.launch.cmd, plan.launch.args, { timeoutMs: 30_000 });
  if (r.error || r.code !== 0) {
    printCommands(`could not open the terminals (${(r.stderr || r.error?.message || `exit ${r.code}`).trim()})`);
    return;
  }
  const where =
    plan.terminal === 'iterm'
      ? 'an iTerm2 window, one pane per role'
      : plan.terminal === 'terminal'
        ? 'one Terminal window per role'
        : 'a Windows Terminal tab, one pane per role';
  ctx.logger.info(`[follow] opened ${where}: ${roles.join(', ')}`);
}
