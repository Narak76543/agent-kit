/**
 * `tossana-agents watch [--runner <tool>] [--interval 5m] [--once] [--retry <taskId>]` (plan Phase 10):
 * polls ClickUp and runs my tasks one at a time, headless, each in its own git worktree, until Ctrl+C.
 *
 * Each poll, in this order: tasks interrupted by an earlier stop (resumed once more), tasks sent back with feedback
 * (resumed with the comment as the coder's top-priority instruction), then new "to do" tasks, oldest first.
 * After NEEDS_HUMAN or a failure nothing extra is posted; the next task follows. State in
 * .tossana/tmp/watch-state.json (main folder), so a restart neither repeats nor forgets work.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { KitError, RUNNERS, statusForRole, type AgentConfig, type ClickUpClient } from '@tossana/agents-core';
import { SilentExit, createClient, loadProject, requireConfig, type CliContext } from '../context.js';
import { pendingFeedback } from '../feedback.js';
import { notify } from '../notify.js';
import { TMP_DIR } from '../paths.js';
import { acquireRunLock } from '../run-lock.js';
import { prepareWorktree } from '../worktrees.js';
import { printChecks, runDoctor } from './doctor.js';
import { lastResult, runTasks } from './run.js';

export const WATCH_STATE = `${TMP_DIR}/watch-state.json`;
/** ClickUp allows 100 requests a minute; a poll makes a few. */
const MIN_INTERVAL_MS = 60_000;
/** An interrupted task is resumed at most this many times in a row, then left for a human. */
const MAX_ATTEMPTS = 2;

type Outcome = 'running' | 'ready' | 'needs-human' | 'failed';
type Kind = 'new' | 'feedback' | 'resume';

export interface TaskState {
  state: Outcome;
  kind: Kind;
  name: string;
  at: string;
  attempts: number;
  /** The human comment a feedback run answered (so it is handled once). */
  feedbackId?: string;
  note?: string;
}
export interface WatchState {
  tasks: Record<string, TaskState>;
}

export function readWatchState(cwd: string): WatchState {
  try {
    const s = JSON.parse(readFileSync(join(cwd, ...WATCH_STATE.split('/')), 'utf8')) as WatchState;
    return { tasks: s.tasks ?? {} };
  } catch {
    return { tasks: {} };
  }
}

function writeWatchState(cwd: string, state: WatchState): void {
  mkdirSync(join(cwd, ...TMP_DIR.split('/')), { recursive: true });
  writeFileSync(join(cwd, ...WATCH_STATE.split('/')), `${JSON.stringify(state, null, 2)}\n`);
}

/** "5m", "90s", "1h" or a number of seconds → milliseconds (at least one minute). */
export function parseInterval(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(text.trim());
  if (!m) throw new KitError(`--interval: use a number with s, m or h, e.g. 5m (got "${text}")`);
  const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's').toLowerCase() as 's' | 'm' | 'h'];
  if (ms < MIN_INTERVAL_MS) throw new KitError('--interval must be at least 1m (ClickUp rate limit)');
  return ms;
}

interface QueueItem {
  id: string;
  name: string;
  kind: Kind;
  feedback?: string;
  feedbackId?: string;
}

export interface WatchOptions {
  runner?: string;
  interval?: string;
  once?: boolean;
  retry?: string;
  /** Let the orchestrator agent run the roles instead of the kit's loop. */
  aiOrchestrator?: boolean;
}

export function registerWatchCommand(program: Command, ctx: CliContext): void {
  program
    .command('watch')
    .description('run my ClickUp tasks automatically, one at a time, each in its own git worktree (Ctrl+C stops)')
    .option('--runner <runner>', `use this runner (${RUNNERS.join(', ')})`)
    .option('--interval <time>', 'time between ClickUp checks, e.g. 5m or 90s (at least 1m)', '5m')
    .option('--once', 'check once, run what is there, then stop')
    .option('--retry <taskId>', 'run a task again that failed or needed a human before')
    .option('--ai-orchestrator', 'let the orchestrator agent run the roles (as subagents) instead of the kit')
    .action((opts: WatchOptions) => watch(ctx, opts));
}

export async function watch(ctx: CliContext, opts: WatchOptions): Promise<void> {
  const log = (s: string) => ctx.logger.info(s);
  const project = loadProject(ctx);
  const config = requireConfig(project);
  const runner = opts.runner ?? config.pipeline.runner;
  if (!(RUNNERS as readonly string[]).includes(runner)) throw new KitError(`unknown runner "${runner}"`);
  const interval = parseInterval(opts.interval ?? '5m');

  log(`[watch] checking the setup for ${runner} (doctor)…`);
  const checks = await runDoctor(ctx, { runner });
  if (checks.some((c) => c.status === 'fail')) {
    printChecks(ctx, checks);
    ctx.logger.error('[watch] not started: fix the failed checks above first.');
    throw new SilentExit(1);
  }

  const lock = acquireRunLock(ctx.cwd, 'watch', ctx.now());
  const controller = new AbortController();
  let stopping = false;
  let wake: (() => void) | null = null;
  const onSigint = () => {
    if (stopping) return;
    stopping = true;
    log('\n[watch] stopping: the running agent is stopped (with everything it started); it resumes next time.');
    controller.abort();
    wake?.();
  };
  process.on('SIGINT', onSigint);
  const state = readWatchState(ctx.cwd);
  if (opts.retry) {
    state.tasks = Object.fromEntries(Object.entries(state.tasks).filter(([id]) => id !== opts.retry));
    writeWatchState(ctx.cwd, state);
  }
  try {
    for (;;) {
      await pollOnce(ctx, config, runner, state, controller.signal, () => stopping, log, opts);
      opts.retry = undefined;
      if (opts.once || stopping) break;
      log(`[watch] next check in ${Math.round(interval / 60_000)} min (Ctrl+C stops)`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, interval);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
      if (stopping) break;
    }
  } finally {
    process.off('SIGINT', onSigint);
    writeWatchState(ctx.cwd, state);
    lock.release();
  }
}

async function pollOnce(
  ctx: CliContext,
  config: AgentConfig,
  runner: string,
  state: WatchState,
  signal: AbortSignal,
  stopping: () => boolean,
  log: (s: string) => void,
  opts: WatchOptions,
): Promise<void> {
  const retry = opts.retry;
  const project = loadProject(ctx);
  const client = createClient(ctx, project);
  const me = await client.getUser();
  const queue: QueueItem[] = [];
  const queued = (id: string) => queue.some((q) => q.id === id);

  // 0. --retry: that task first, whatever happened before (still "to do": a new run; otherwise a resume).
  if (retry) {
    const t = await client.getTask(retry, { subtasks: false });
    const todo = (t.status?.status ?? '').toLowerCase() === statusForRole(config, 'todo').toLowerCase();
    queue.push({ id: t.id, name: t.name, kind: todo ? 'new' : 'resume' });
  }

  // 1. interrupted by an earlier stop
  for (const [id, s] of Object.entries(state.tasks)) {
    if (s.state !== 'running') continue;
    if (s.attempts >= MAX_ATTEMPTS) {
      state.tasks[id] = { ...s, state: 'failed', note: `stopped ${s.attempts} times; left for a human` };
      continue;
    }
    queue.push({ id, name: s.name, kind: 'resume' });
  }

  // 2. sent back with feedback: in coding, with a human comment after the pipeline's last result
  const coding = await client.getListTasks(config.clickup.listId, {
    statuses: [statusForRole(config, 'coding')],
    assignees: [me.id],
  });
  for (const t of coding) {
    if (queued(t.id)) continue;
    const fb = pendingFeedback(await client.getComments(t.id));
    if (fb && state.tasks[t.id]?.feedbackId !== fb.commentId) {
      queue.push({ id: t.id, name: t.name, kind: 'feedback', feedback: fb.text, feedbackId: fb.commentId });
    }
  }

  // 3. new "to do" tasks, oldest first
  const todo = await client.getListTasks(config.clickup.listId, {
    statuses: [statusForRole(config, 'todo')],
    assignees: [me.id],
  });
  for (const t of todo.reverse()) {
    if (queued(t.id)) continue;
    const s = state.tasks[t.id];
    if (s && s.state !== 'running') {
      log(`[watch] skipping ${t.id} (${s.state} before; run it again with: tossana-agents watch --retry ${t.id})`);
      continue;
    }
    queue.push({ id: t.id, name: t.name, kind: 'new' });
  }

  log(
    `[watch] ${new Date().toLocaleTimeString()}: ${queue.length ? queue.map((q) => `${q.id} (${q.kind})`).join(', ') : 'nothing to do'}`,
  );
  for (const item of queue) {
    if (stopping()) break;
    await runOne(ctx, config, client, runner, state, item, signal, stopping, log, !!opts.aiOrchestrator);
  }
}

async function runOne(
  ctx: CliContext,
  config: AgentConfig,
  client: ClickUpClient,
  runner: string,
  state: WatchState,
  item: QueueItem,
  signal: AbortSignal,
  stopping: () => boolean,
  log: (s: string) => void,
  aiOrchestrator: boolean,
): Promise<void> {
  log(`\n[watch] ===== ${item.id}: ${item.name} (${item.kind}) =====`);
  const prev = state.tasks[item.id];
  state.tasks[item.id] = {
    state: 'running',
    kind: item.kind,
    name: item.name,
    at: ctx.now().toISOString(),
    attempts: (prev?.state === 'running' ? prev.attempts : 0) + 1,
    feedbackId: item.feedbackId ?? prev?.feedbackId,
  };
  writeWatchState(ctx.cwd, state);

  let outcome: Outcome = 'failed';
  let note: string;
  try {
    const wt = prepareWorktree(ctx, config, item.id, log);
    await runTasks(
      { ...ctx, cwd: wt.path },
      {
        task: item.id,
        runner,
        resume: item.kind !== 'new',
        feedback: item.feedback,
        yes: true,
        signal,
        aiOrchestrator,
      },
    );
    const result = await outcomeOf(client, config, item.id);
    outcome = result.outcome;
    note = result.note;
  } catch (e) {
    note = (e as Error).message.split('\n')[0]!;
    if (!stopping()) ctx.logger.error(`[watch] ${item.id} failed: ${note}`);
  }
  if (stopping()) outcome = 'running'; // interrupted: resume next time
  state.tasks[item.id] = { ...state.tasks[item.id]!, state: outcome, note, at: ctx.now().toISOString() };
  writeWatchState(ctx.cwd, state);
  log(`[watch] ${item.id}: ${outcome}${note ? ` (${note})` : ''}`);

  if (outcome === 'ready' || outcome === 'needs-human') {
    const title = outcome === 'ready' ? `Ready for review: ${item.name}` : `Needs you: ${item.name}`;
    notify(ctx.exec, ctx.platform, title, `${item.id} · ${note}`);
  }
}

/** Where the task ended: the human status (ready for review), a NEEDS_HUMAN result, or neither (failed). */
async function outcomeOf(
  client: ClickUpClient,
  config: AgentConfig,
  taskId: string,
): Promise<{ outcome: Outcome; note: string }> {
  const [task, last] = await Promise.all([client.getTask(taskId, { subtasks: false }), lastResult(client, taskId)]);
  const status = task.status?.status ?? '';
  const summary = last?.summary.split('\n')[0] ?? '';
  if (last?.result === 'NEEDS_HUMAN') return { outcome: 'needs-human', note: summary || `status "${status}"` };
  if (status.toLowerCase() === statusForRole(config, 'human').toLowerCase()) {
    return { outcome: 'ready', note: summary || 'ready for review' };
  }
  return { outcome: 'failed', note: `ended in "${status}"${last ? ` after ${last.agent} ${last.result}` : ''}` };
}
