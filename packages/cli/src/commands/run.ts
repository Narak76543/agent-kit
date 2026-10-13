/**
 * `tossana-agents run`: runs ClickUp tasks through the orchestrator agent, one at a time.
 * Ported from EKMONG_MOBILE scripts/run-pipeline.ts. Prepares the task branch, streams the agent's
 * output to the console and to .agents/logs/ (tokens redacted), and never pushes.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import type { Command } from 'commander';
import {
  KitError,
  RUNNERS,
  isClosedType,
  isValidTaskId,
  parseAgentComment,
  statusForRole,
  type AgentComment,
  type AgentConfig,
  type ClickUpClient,
} from '@tossana/agents-core';
import { createClient, loadProject, requireConfig, type CliContext, type Project } from '../context.js';
import { acquireRunLock } from '../run-lock.js';
import { assertToolFiles, recordRunStart, resumeTask } from './resume.js';
import { ORCHESTRATOR, adapterFor, formatCommand, taskPrompt, type RunnerCommand } from '../runners.js';

export interface RunOptions {
  task?: string;
  next?: boolean;
  all?: boolean;
  dryRun?: boolean;
  /** commander's --no-agent sets agent=false */
  agent?: boolean;
  /** Continue a task another tool started (keeps the branch and the round). */
  resume?: boolean;
  /** Use this runner instead of pipeline.runner for this run. */
  runner?: string;
  /** With --resume: commit leftover changes without asking. */
  yes?: boolean;
  /** Stops the agent (whole process tree), e.g. the Local Console's Stop button. */
  signal?: AbortSignal;
}

export const LOG_DIR = join('.agents', 'logs');

export function registerRunCommand(program: Command, ctx: CliContext): void {
  program
    .command('run')
    .description('run ClickUp tasks through the agents (one at a time, never pushes)')
    .option('--task <taskId>', 'run one task')
    .option('--next', 'run the next "todo" task assigned to me')
    .option('--all', 'run all "todo" tasks assigned to me, one at a time')
    .option('--dry-run', 'show what would happen (and the exact command) without changing anything')
    .option('--no-agent', 'only prepare the task branch (then work in OpenCode/Antigravity yourself)')
    .option('--resume', 'continue a task another tool started: keeps its branch and round (with --task)')
    .option('--runner <runner>', `use this runner for this run (${RUNNERS.join(', ')})`)
    .option('-y, --yes', 'with --resume: commit leftover changes as "WIP: handoff from …" without asking')
    .action((opts: RunOptions) => runTasks(ctx, opts));
}

interface TaskRef {
  id: string;
  name: string;
}

export async function runTasks(ctx: CliContext, opts: RunOptions): Promise<void> {
  const modes = [opts.task !== undefined, !!opts.next, !!opts.all].filter(Boolean).length;
  if (modes !== 1) throw new KitError('choose one: --task <taskId>, --next or --all');

  const project = loadProject(ctx);
  const config = withRunner(requireConfig(project), opts.runner);
  // One run per project at a time (CLI and Local Console alike). A dry run changes nothing, so it needs no lock.
  const lock = opts.dryRun ? null : acquireRunLock(ctx.cwd, opts.task, ctx.now());
  try {
    await runLocked(ctx, opts, project, config);
  } finally {
    lock?.release();
  }
}

async function runLocked(ctx: CliContext, opts: RunOptions, project: Project, config: AgentConfig): Promise<void> {
  const log = (s: string) => ctx.logger.info(s);
  if (opts.resume) {
    if (!opts.task) throw new KitError('--resume needs --task <taskId>');
    const client = opts.dryRun ? null : createClient(ctx, project);
    return resumeTask(
      ctx,
      project,
      config,
      client,
      { ...opts, task: opts.task },
      {
        git: (args) => git(ctx, args),
        runAgent: (command) => runAgent(ctx, command, opts.task!, config.pipeline.timeoutMinutes, opts.signal),
        lastResult,
      },
    );
  }
  if (opts.runner) assertToolFiles(ctx.cwd, config, config.pipeline.runner);
  const todo = statusForRole(config, 'todo');

  // A dry run for one task needs no ClickUp access at all.
  const client = opts.dryRun && opts.task ? null : createClient(ctx, project);
  const tasks: TaskRef[] = opts.task
    ? [{ id: opts.task, name: '' }]
    : await myTodoTasks(client!, config, opts.next ? 1 : Infinity);
  if (!tasks.length) {
    log(`[run] no "${todo}" tasks assigned to you in list ${config.clickup.listId}`);
    return;
  }

  const summary: string[] = [];
  for (const task of tasks) {
    if (!isValidTaskId(task.id)) throw new KitError(`invalid task id "${task.id}"`);
    const branch = `${config.pipeline.branchPrefix}${task.id}`;
    const adapter = adapterFor(config, project.env, ctx.exec, ctx.cwd, task.id);
    const command =
      adapter.headless && opts.agent !== false
        ? adapter.buildCommand({ agent: ORCHESTRATOR, prompt: taskPrompt(task.id), cwd: ctx.cwd })
        : null;

    log(`\n[run] ===== ${task.id}${task.name ? `: ${task.name}` : ''} =====`);
    if (opts.dryRun) {
      log(`[run] dry run: nothing is changed`);
      log(`  git: ${describeBranchStep(ctx, config, branch)}`);
      if (command) log(`  $ ${formatCommand(command)}`);
      else
        log(
          `  (no agent is started: ${opts.agent === false ? '--no-agent' : `runner "${adapter.name}" has no headless mode`})`,
        );
      log(`  log: ${join(LOG_DIR, `${task.id}-<timestamp>.log`)}`);
      continue;
    }

    // Re-check: the task may have moved since it was listed, or be closed.
    const current = await client!.getTask(task.id, { subtasks: false });
    if (isClosedType(current.status?.type)) {
      summary.push(`${task.id}: skipped (task is closed: "${current.status?.status}")`);
      continue;
    }
    if (!opts.task && current.status?.status.toLowerCase() !== todo.toLowerCase()) {
      summary.push(`${task.id}: skipped (status is now "${current.status?.status}")`);
      continue;
    }

    prepareBranch(ctx, config, branch);
    recordRunStart(ctx, task.id, config.pipeline.runner);
    log(`[run] on branch ${branch}`);

    if (!command) {
      if (opts.agent === false) {
        log(`[run] branch ready. Start the agent yourself, e.g. in OpenCode: "${taskPrompt(task.id)}"`);
      } else {
        log(
          `[run] ${adapter.name} has no headless runner. Open this project in Antigravity and run: /start-task ${task.id}`,
        );
      }
      summary.push(`${task.id}: branch ${branch} ready (no agent started)`);
      continue;
    }
    if (!(await adapter.isInstalled())) throw new KitError(`${adapter.name} is not available. ${adapter.installHint}`);

    const code = await runAgent(ctx, command, task.id, config.pipeline.timeoutMinutes, opts.signal);
    const result = await lastResult(client!, task.id);
    const after = await client!.getTask(task.id, { subtasks: false });
    summary.push(
      `${task.id}: agent exit ${code ?? 'killed'}, status "${after.status?.status ?? '?'}", ` +
        `${result ? `last result ${result.agent} ${result.result} (round ${result.round ?? '?'})` : 'no agent comment found'}, ` +
        `rounds used ${result?.rounds ?? 0}, branch ${branch}`,
    );

    const leftover = dirtyFiles(ctx);
    if (leftover) {
      summary.push(`STOPPED: ${task.id} left uncommitted changes on ${branch}:\n${leftover}`);
      break;
    }
    git(ctx, ['switch', config.pipeline.baseBranch]);
  }

  if (summary.length) {
    log('\n[run] summary');
    for (const line of summary) log(`  ${line}`);
    log('  Nothing was pushed. Review the task branch(es) locally.');
  }
}

/** `--runner` overrides pipeline.runner for this run only. */
function withRunner(config: AgentConfig, runner: string | undefined): AgentConfig {
  if (!runner) return config;
  if (!(RUNNERS as readonly string[]).includes(runner)) {
    throw new KitError(`unknown runner "${runner}". Use one of: ${RUNNERS.join(', ')}`);
  }
  return { ...config, pipeline: { ...config.pipeline, runner: runner as AgentConfig['pipeline']['runner'] } };
}

async function myTodoTasks(client: ClickUpClient, config: AgentConfig, limit: number): Promise<TaskRef[]> {
  const me = await client.getUser();
  const tasks = await client.getListTasks(config.clickup.listId, {
    statuses: [statusForRole(config, 'todo')],
    assignees: [me.id],
  });
  // ClickUp returns newest first; run the oldest first.
  return tasks
    .reverse()
    .slice(0, limit)
    .map((t) => ({ id: t.id, name: t.name }));
}

// ---------- git ----------

function git(ctx: CliContext, args: string[]): { ok: boolean; out: string; err: string } {
  const res = ctx.exec('git', args, { cwd: ctx.cwd });
  return { ok: res.code === 0, out: res.stdout.trim(), err: (res.stderr || res.error?.message || '').trim() };
}

/** Tracked files with uncommitted changes. Untracked files (handoff notes, logs) are fine. */
function dirtyFiles(ctx: CliContext): string {
  return git(ctx, ['status', '--porcelain', '--untracked-files=no']).out;
}

const branchExists = (ctx: CliContext, branch: string) =>
  git(ctx, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;

function describeBranchStep(ctx: CliContext, config: AgentConfig, branch: string): string {
  const current = git(ctx, ['branch', '--show-current']).out;
  if (current === branch) return `already on ${branch}`;
  if (branchExists(ctx, branch)) return `switch to existing branch ${branch}`;
  return `create ${branch} from ${config.pipeline.baseBranch}`;
}

function prepareBranch(ctx: CliContext, config: AgentConfig, branch: string): void {
  if (!git(ctx, ['rev-parse', '--is-inside-work-tree']).ok) {
    throw new KitError('this folder is not a git repository. Run "git init" and commit your code first.');
  }
  if (config.pipeline.requireCleanGit) {
    const dirty = dirtyFiles(ctx);
    if (dirty) throw new KitError(`the working tree has uncommitted changes; commit or stash them first:\n${dirty}`);
  }
  if (git(ctx, ['branch', '--show-current']).out === branch) return;

  const step = branchExists(ctx, branch)
    ? git(ctx, ['switch', branch])
    : (() => {
        const base = config.pipeline.baseBranch;
        const toBase = git(ctx, ['switch', base]);
        if (!toBase.ok) {
          throw new KitError(
            `could not switch to the base branch "${base}": ${toBase.err}\nSet pipeline.baseBranch in agent.config.json.`,
          );
        }
        return git(ctx, ['switch', '-c', branch]);
      })();
  if (!step.ok) throw new KitError(`could not switch to ${branch}: ${step.err}`);
}

// ---------- agent process ----------

/** Splits a stream into lines so a token can never be cut in half between two chunks. */
function lineRedactor(redact: (s: string) => string, write: (s: string) => void) {
  let buffer = '';
  return {
    push(chunk: Buffer | string) {
      buffer += chunk.toString();
      const end = buffer.lastIndexOf('\n');
      if (end < 0) return;
      write(redact(buffer.slice(0, end + 1)));
      buffer = buffer.slice(end + 1);
    },
    flush() {
      if (buffer) write(redact(buffer));
      buffer = '';
    },
  };
}

function runAgent(
  ctx: CliContext,
  command: RunnerCommand,
  taskId: string,
  timeoutMinutes: number,
  signal?: AbortSignal,
): Promise<number | null> {
  mkdirSync(join(ctx.cwd, LOG_DIR), { recursive: true });
  const logPath = join(LOG_DIR, `${taskId}-${ctx.now().toISOString().replace(/[:.]/g, '-')}.log`);
  const logFile = createWriteStream(join(ctx.cwd, logPath));
  const redact = (s: string) => ctx.logger.redact(s);
  ctx.logger.info(`$ ${formatCommand(command)}\n  (log: ${logPath})`);
  logFile.write(`$ ${redact(formatCommand(command))}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, command.args, {
      cwd: ctx.cwd,
      // A stale PWD (Git Bash, `--cwd`) would point Node/Bun-based agents at the wrong folder.
      env: { ...process.env, PWD: ctx.cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // macOS/Linux: its own process group, so Stop and timeouts can kill everything the agent started.
      // (Windows: taskkill /T walks the tree; detached would open a console window there.)
      detached: process.platform !== 'win32',
    });
    const out = lineRedactor(redact, (s) => {
      ctx.io.out(s);
      logFile.write(s);
    });
    const err = lineRedactor(redact, (s) => {
      ctx.io.err(s);
      logFile.write(s);
    });
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));

    const stop = (why: string) => {
      ctx.logger.warn(`\n[run] ${taskId}: ${why}, stopping the agent`);
      killTree(ctx, child.pid);
    };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMinutes} min`), timeoutMinutes * 60_000);
    const onSigint = () => stop('interrupted (Ctrl+C)');
    process.once('SIGINT', onSigint);
    const onAbort = () => stop('stopped by the user');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const done = () => {
      clearTimeout(timer);
      process.off('SIGINT', onSigint);
      signal?.removeEventListener('abort', onAbort);
      out.flush();
      err.flush();
    };
    child.on('error', (e) => {
      done();
      logFile.end(() => reject(new KitError(`could not start "${command.cmd}": ${e.message}`)));
    });
    child.on('close', (code) => {
      done();
      logFile.end(() => resolve(code));
    });
  });
}

/**
 * Kills the agent and everything it started. On Windows the agent may run under cmd.exe (npm .cmd shims), so
 * taskkill /T walks the tree; elsewhere the agent leads its own process group (see `detached` above).
 * Uses the real platform: this is a real process, even when tests fake ctx.platform.
 */
export function killTree(ctx: CliContext, pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    ctx.exec('taskkill', ['/pid', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

// ---------- result ----------

/** The last agent comment on the task, plus the highest round seen. */
export async function lastResult(
  client: ClickUpClient,
  taskId: string,
): Promise<(AgentComment & { rounds: number }) | null> {
  const parsed = (await client.getComments(taskId))
    .map((c) => parseAgentComment(c.comment_text ?? ''))
    .filter((c): c is AgentComment => c !== null);
  const last = parsed[parsed.length - 1];
  if (!last) return null;
  return { ...last, rounds: Math.max(0, ...parsed.map((c) => c.round ?? 0)) };
}
