/**
 * What the Local Console can do. Every action calls the same functions as the CLI commands (runDoctor, runTasks
 * with dryRun / resume / runner / signal) with an in-process context whose output goes to the browser instead of
 * the terminal. Nothing here builds a shell string, and nothing returns .env values.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_FILE,
  KitError,
  ROLES,
  RUNNERS,
  clickUpErrorHint,
  isValidTaskId,
  loadEnv,
  readHandoff,
  redact,
  statusForRole,
  type AgentConfig,
  type Role,
} from '@tossana/agents-core';
import { z } from 'zod';
import { createClient, createContext, loadProject, type CliContext } from '../context.js';
import { runDoctor } from '../commands/doctor.js';
import { RUNNER_FILES, previousTool } from '../commands/resume.js';
import { lastResult, runTasks } from '../commands/run.js';
import { readRunLock } from '../run-lock.js';
import { KIT_VERSION } from '../version.js';
import { secretValues } from './security.js';

/** An error with the HTTP status the console answers with. */
export class ConsoleError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type RunMode = 'run' | 'resume';
export type RunState = 'running' | 'done' | 'failed' | 'stopped';

export const previewInput = z.object({
  taskId: z.string().refine(isValidTaskId, 'invalid task id'),
  mode: z.enum(['run', 'resume']),
  runner: z.enum(RUNNERS),
});
export const startInput = z.object({ previewId: z.string().min(1).max(100), confirmWip: z.boolean().optional() });

const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_LOG_LINES = 10_000;

interface Preview {
  taskId: string;
  mode: RunMode;
  runner: string;
  at: number;
}

export interface RunInfo {
  id: number;
  taskId: string;
  mode: RunMode;
  runner: string;
  state: RunState;
  startedAt: string;
  /** Index of the first line still kept (old lines are dropped after MAX_LOG_LINES). */
  firstLine: number;
  lineCount: number;
}

export type RunEvent = { type: 'line'; index: number; text: string } | { type: 'state'; state: RunState };

/** One run's log (already redacted) and the people watching it. */
class RunSession {
  state: RunState = 'running';
  lines: string[] = [];
  firstLine = 0;
  private partial = '';
  private listeners = new Set<(e: RunEvent) => void>();
  readonly controller = new AbortController();
  done!: Promise<void>;

  constructor(
    readonly id: number,
    readonly taskId: string,
    readonly mode: RunMode,
    readonly runner: string,
    readonly startedAt: string,
    private readonly clean: (s: string) => string,
  ) {}

  write(text: string) {
    const parts = (this.partial + text).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.push(line);
  }

  private push(line: string) {
    const text = this.clean(line);
    this.lines.push(text);
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines.shift();
      this.firstLine++;
    }
    const event: RunEvent = { type: 'line', index: this.firstLine + this.lines.length - 1, text };
    for (const l of this.listeners) l(event);
  }

  finish(state: RunState) {
    if (this.partial) this.push(this.partial);
    this.partial = '';
    this.state = state;
    for (const l of this.listeners) l({ type: 'state', state });
    this.listeners.clear();
  }

  /** Replays lines from `from`, then follows. Returns an unsubscribe function. */
  subscribe(from: number, listener: (e: RunEvent) => void): () => void {
    const start = Math.max(from, this.firstLine);
    this.lines.slice(start - this.firstLine).forEach((text, i) => listener({ type: 'line', index: start + i, text }));
    if (this.state !== 'running') {
      listener({ type: 'state', state: this.state });
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  info(): RunInfo {
    return {
      id: this.id,
      taskId: this.taskId,
      mode: this.mode,
      runner: this.runner,
      state: this.state,
      startedAt: this.startedAt,
      firstLine: this.firstLine,
      lineCount: this.firstLine + this.lines.length,
    };
  }
}

export class ConsoleApp {
  private previews = new Map<string, Preview>();
  private session: RunSession | null = null;
  private runCounter = 0;

  /** `base` is the CLI's context: its cwd, environment, fetch and exec are reused, its output is not. */
  constructor(private readonly base: CliContext) {}

  get cwd() {
    return this.base.cwd;
  }

  /** Redacts ClickUp tokens and every secret-looking value from .env and the process environment. */
  redact(text: string): string {
    return redact(text, secretValues(loadEnv(this.cwd, this.base.processEnv), this.base.processEnv));
  }

  /** A context like the CLI's, with output going to `sink` instead of the terminal. Never interactive. */
  private context(sink: (text: string) => void = () => {}): CliContext {
    return createContext({
      cwd: this.base.cwd,
      processEnv: this.base.processEnv,
      fetch: this.base.fetch,
      exec: this.base.exec,
      platform: this.base.platform,
      now: this.base.now,
      io: { out: sink, err: sink, readStdin: async () => '', interactive: false },
    });
  }

  private config(): AgentConfig {
    const { config } = loadProject(this.context());
    if (!config) throw new ConsoleError(409, `${CONFIG_FILE} not found. Run: tossana-agents init`);
    return config;
  }

  /** Runners whose files exist in this project (custom: when AGENT_CMD is set). */
  availableRunners(config: AgentConfig): string[] {
    const env = loadEnv(this.cwd, this.base.processEnv);
    return RUNNERS.filter((r) => {
      const need = RUNNER_FILES[r];
      if (need) return config.tools.includes(need.tool as never) && existsSync(join(this.cwd, need.file));
      return r === 'custom' && !!env.AGENT_CMD?.trim();
    });
  }

  project() {
    let config: AgentConfig | null = null;
    let configError: string | undefined;
    try {
      config = loadProject(this.context()).config;
    } catch (e) {
      configError = (e as Error).message;
    }
    const runners = config ? this.availableRunners(config) : [];
    return {
      kitVersion: KIT_VERSION,
      cwd: this.cwd,
      configError,
      project: config
        ? {
            name: config.project.name,
            listId: config.clickup.listId,
            baseBranch: config.pipeline.baseBranch,
            tools: config.tools,
            runners,
            defaultRunner: runners.includes(config.pipeline.runner) ? config.pipeline.runner : (runners[0] ?? null),
          }
        : null,
      run: this.session?.info() ?? null,
    };
  }

  async doctor() {
    return { checks: await runDoctor(this.context()) };
  }

  /** My tasks in the configured list, in the agent statuses and the human one. */
  async tasks() {
    const ctx = this.context();
    const project = loadProject(ctx);
    const config = this.config();
    const client = createClient(ctx, project);
    const me = await client.getUser();
    const statuses = ROLES.map((r) => statusForRole(config, r));
    const tasks = await client.getListTasks(config.clickup.listId, { statuses, assignees: [me.id] });
    return {
      me: { id: me.id, username: me.username },
      tasks: tasks.reverse().map((t) => {
        const role = roleOf(config, t.status?.status);
        const branchExists = this.branchExists(`${config.pipeline.branchPrefix}${t.id}`);
        const action: RunMode | null =
          role === 'todo' ? 'run' : role && role !== 'human' && branchExists ? 'resume' : null;
        return {
          id: t.id,
          customId: t.custom_id ?? null,
          name: t.name,
          status: t.status?.status ?? '',
          role,
          url: t.url ?? null,
          branchExists,
          action,
          note:
            role === 'human'
              ? 'Waiting for you: review the task branch.'
              : role && role !== 'todo' && !branchExists
                ? 'In progress, but there is no task branch here (started on another machine?).'
                : undefined,
        };
      }),
    };
  }

  /** `run --dry-run` (or `run --resume --dry-run`) for the task, plus what the start would need confirmed. */
  async preview(raw: unknown) {
    const input = parse(previewInput, raw);
    const config = this.config();
    if (!this.availableRunners(config).includes(input.runner))
      throw new ConsoleError(400, `${input.runner} is not set up in this project`);
    let output = '';
    await runTasks(
      this.context((t) => (output += t)),
      {
        task: input.taskId,
        dryRun: true,
        resume: input.mode === 'resume',
        runner: input.runner,
      },
    );
    this.dropOldPreviews();
    const previewId = randomUUID();
    this.previews.set(previewId, { ...input, at: Date.now() });
    return {
      previewId,
      output: output.trimEnd(),
      ...this.gitState(config, input.taskId, input.mode),
      busy: this.busy(),
    };
  }

  /** Starts a previewed run. Needs the preview id (the UI's confirmation) and, for leftover changes, confirmWip. */
  start(raw: unknown): RunInfo {
    const { previewId, confirmWip } = parse(startInput, raw);
    const busy = this.busy();
    if (busy) throw new ConsoleError(409, busy);
    this.dropOldPreviews();
    const preview = this.previews.get(previewId);
    if (!preview) throw new ConsoleError(409, 'This preview has expired. Preview the run again.');
    const config = this.config();
    const git = this.gitState(config, preview.taskId, preview.mode);
    if (git.needsWipCommit && !confirmWip) {
      throw new ConsoleError(409, 'The task branch has uncommitted changes; confirm the WIP commit first.', {
        needsWipCommit: true,
        dirty: git.dirty,
      });
    }
    this.previews.delete(previewId);

    const session = new RunSession(
      ++this.runCounter,
      preview.taskId,
      preview.mode,
      preview.runner,
      this.base.now().toISOString(),
      (s) => this.redact(s),
    );
    this.session = session;
    const ctx = this.context((t) => session.write(t));
    session.done = runTasks(ctx, {
      task: preview.taskId,
      resume: preview.mode === 'resume',
      runner: preview.runner,
      yes: confirmWip === true,
      signal: session.controller.signal,
    }).then(
      () => session.finish(session.controller.signal.aborted ? 'stopped' : 'done'),
      (e: unknown) => {
        session.write(`\nERROR: ${(e as Error)?.message ?? String(e)}\n`);
        const hint = e instanceof KitError ? clickUpErrorHint(e) : undefined;
        if (hint) session.write(`FIX: ${hint}\n`);
        session.finish(session.controller.signal.aborted ? 'stopped' : 'failed');
      },
    );
    return session.info();
  }

  /** Stops the current run: the agent and everything it started (see killTree). */
  stop(): RunInfo {
    const s = this.session;
    if (!s || s.state !== 'running') throw new ConsoleError(409, 'No run is going.');
    s.write('[console] Stop pressed\n');
    s.controller.abort();
    return s.info();
  }

  /** Stops a running run and waits for it (used when the console shuts down). */
  async shutdown(): Promise<void> {
    const s = this.session;
    if (s?.state === 'running') {
      s.controller.abort();
      await s.done;
    }
  }

  currentRun(): RunInfo | null {
    return this.session?.info() ?? null;
  }

  subscribe(from: number, listener: (e: RunEvent) => void): () => void {
    if (!this.session) throw new ConsoleError(404, 'No run yet.');
    return this.session.subscribe(from, listener);
  }

  /** Where the current run is: ClickUp status → role, the last agent comment and round, the last handoff entry. */
  async runStatus() {
    const s = this.session;
    if (!s) throw new ConsoleError(404, 'No run yet.');
    const ctx = this.context();
    const config = this.config();
    const client = createClient(ctx, loadProject(ctx));
    const [task, last] = await Promise.all([
      client.getTask(s.taskId, { subtasks: false }),
      lastResult(client, s.taskId),
    ]);
    const handoff = readHandoff(this.cwd, s.taskId);
    const headings = [...(handoff ?? '').matchAll(/^## \S+ — (.+)$/gm)].map((m) => m[1]!);
    return {
      taskId: s.taskId,
      name: task.name,
      status: task.status?.status ?? '',
      role: roleOf(config, task.status?.status),
      round: last?.round ?? null,
      rounds: last?.rounds ?? 0,
      lastAgent: last?.agent ?? null,
      lastResult: last?.result ?? null,
      lastSummary: last?.summary ?? null,
      next: last?.next ?? null,
      handoff: headings.at(-1) ?? null,
      tool: previousTool(handoff),
    };
  }

  // ---------- helpers ----------

  /** Why a run cannot start now, or null. */
  private busy(): string | null {
    if (this.session?.state === 'running') return `A run is already going (task ${this.session.taskId}).`;
    const lock = readRunLock(this.cwd);
    if (lock) return `Another run is going in this project (pid ${lock.pid}${lock.task ? `, task ${lock.task}` : ''}).`;
    return null;
  }

  private git(args: string[]) {
    const r = this.base.exec('git', args, { cwd: this.cwd });
    return { ok: r.code === 0, out: r.stdout.trim() };
  }

  private branchExists(branch: string) {
    return this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  }

  /**
   * Resume: leftover changes are only on the task branch when it is checked out, and resume would commit them as
   * "WIP: handoff from …" (a write the user must confirm). Run: uncommitted changes stop the run when
   * pipeline.requireCleanGit is on.
   */
  private gitState(config: AgentConfig, taskId: string, mode: RunMode) {
    const branch = `${config.pipeline.branchPrefix}${taskId}`;
    const current = this.git(['branch', '--show-current']).out;
    const warnings: string[] = [];
    if (mode === 'resume') {
      const dirty = current === branch ? this.git(['status', '--porcelain']).out : '';
      const tracked = current !== branch ? this.git(['status', '--porcelain', '--untracked-files=no']).out : '';
      if (tracked)
        warnings.push(`You have uncommitted changes on ${current}; the resume will stop. Commit or stash them first.`);
      return { needsWipCommit: !!dirty, dirty: dirty || tracked, warnings };
    }
    const dirty = this.git(['status', '--porcelain', '--untracked-files=no']).out;
    if (dirty && config.pipeline.requireCleanGit)
      warnings.push('The working tree has uncommitted changes; the run will stop. Commit or stash them first.');
    return { needsWipCommit: false, dirty, warnings };
  }

  private dropOldPreviews() {
    const now = Date.now();
    for (const [id, p] of this.previews) if (now - p.at > PREVIEW_TTL_MS) this.previews.delete(id);
  }
}

function roleOf(config: AgentConfig, status: string | undefined): Role | null {
  if (!status) return null;
  return ROLES.find((r) => statusForRole(config, r).toLowerCase() === status.toLowerCase()) ?? null;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new ConsoleError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
