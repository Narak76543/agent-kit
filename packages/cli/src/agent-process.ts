/**
 * Starts one headless agent process: streams its output to the console and to a log file (tokens redacted), renders
 * stream-json output readably (agent-stream.ts), and stops it with everything it started on Ctrl+C, the Local
 * Console's Stop button or the timeout.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import spawn from 'cross-spawn';
import { KitError } from '@tossana/agents-core';
import { streamRenderer, type OutputFormat } from './agent-stream.js';
import type { CliContext } from './context.js';
import { formatCommand, type RunnerCommand } from './runners.js';

export interface SpawnAgentOptions {
  cwd: string;
  /** Names the run in messages, e.g. "T1" or "T1 round 2 coder". */
  label: string;
  /** Absolute path of the readable log (appended to). */
  logPath: string;
  /** Absolute path for the raw output of a stream format (appended to). */
  rawPath?: string;
  format: OutputFormat;
  timeoutMinutes: number;
  signal?: AbortSignal;
}

export interface AgentRun {
  /** Exit code; null when killed. */
  code: number | null;
  /** Why the kit stopped the agent, or null when it ended by itself. */
  stopped: 'timeout' | 'interrupted' | 'aborted' | null;
  /** The agent's final answer (stream formats) or its whole output, for finding its report. */
  text: string;
}

/** Splits a stream into lines so a token can never be cut in half between two chunks. */
function lineSplitter(onLine: (line: string) => void) {
  let buffer = '';
  return {
    push(chunk: Buffer | string) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const l of lines) onLine(l.replace(/\r$/, ''));
    },
    flush() {
      if (buffer) onLine(buffer.replace(/\r$/, ''));
      buffer = '';
    },
  };
}

const open = (path: string): WriteStream => {
  mkdirSync(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: 'a' });
};

const end = (s: WriteStream | undefined) => new Promise<void>((resolve) => (s ? s.end(resolve) : resolve()));

export function spawnAgent(ctx: CliContext, command: RunnerCommand, opts: SpawnAgentOptions): Promise<AgentRun> {
  const redact = (s: string) => ctx.logger.redact(s);
  const log = open(opts.logPath);
  const raw = opts.rawPath ? open(opts.rawPath) : undefined;
  log.write(`$ ${redact(formatCommand(command))}\n`);
  const renderer = streamRenderer(opts.format);

  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, command.args, {
      cwd: opts.cwd,
      // A stale PWD (Git Bash, `--cwd`) would point Node/Bun-based agents at the wrong folder.
      // TOSSANA_AGENT: commands meant for people only (review) refuse to run inside an agent.
      env: { ...process.env, PWD: opts.cwd, TOSSANA_AGENT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // macOS/Linux: its own process group, so Stop and timeouts can kill everything the agent started.
      // (Windows: taskkill /T walks the tree; detached would open a console window there.)
      detached: process.platform !== 'win32',
    });
    const show = (lines: string[], to: (s: string) => void) => {
      for (const l of lines) {
        const text = `${redact(l)}\n`;
        to(text);
        log.write(text);
      }
    };
    const out = lineSplitter((line) => {
      raw?.write(`${redact(line)}\n`);
      show(renderer.line(line), ctx.io.out);
    });
    const err = lineSplitter((line) => show([line], ctx.io.err));
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));

    let stopped: AgentRun['stopped'] = null;
    const stop = (why: AgentRun['stopped'], text: string) => {
      if (stopped) return;
      stopped = why;
      ctx.logger.warn(`\n[run] ${opts.label}: ${text}, stopping the agent`);
      log.write(`[run] ${text}, agent stopped\n`);
      killTree(ctx, child.pid);
    };
    const timer = setTimeout(
      () => stop('timeout', `timed out after ${opts.timeoutMinutes} min`),
      opts.timeoutMinutes * 60_000,
    );
    const onSigint = () => stop('interrupted', 'interrupted (Ctrl+C)');
    process.once('SIGINT', onSigint);
    const onAbort = () => stop('aborted', 'stopped by the user');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const done = () => {
      clearTimeout(timer);
      process.off('SIGINT', onSigint);
      opts.signal?.removeEventListener('abort', onAbort);
      out.flush();
      err.flush();
      show(renderer.end(), ctx.io.out);
    };
    child.on('error', (e) => {
      done();
      void Promise.all([end(log), end(raw)]).then(() =>
        reject(new KitError(`could not start "${command.cmd}": ${e.message}`)),
      );
    });
    child.on('close', (code) => {
      done();
      void Promise.all([end(log), end(raw)]).then(() => resolve({ code, stopped, text: renderer.finalText() }));
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
