/**
 * Logs of the kit's pipeline: `.agents/logs/<taskId>/` in the project's main folder (not the task's worktree), so
 * `tossana-agents follow` finds them from any folder of the project.
 *
 * - `<round>-<role>.log`: what the role's agent did, readable (the stream formats rendered, see agent-stream.ts);
 * - `<round>-<role>.jsonl`: the raw events next to it (agy and Claude Code only);
 * - `pipeline.log`: the kit's own lines (statuses, results, decisions), ending with a `FINISHED` marker.
 * A resumed run appends to the same files under a separator; nothing is overwritten. Tokens are redacted.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Exec } from './exec.js';

export const LOGS_DIR = join('.agents', 'logs');
export const PIPELINE_LOG = 'pipeline.log';
/** Last line of a finished pipeline run in pipeline.log (follow stops there). */
export const FINISHED_MARK = '=== FINISHED';
/** First line of every pipeline run in pipeline.log. */
export const RUN_MARK = '=== RUN';

/**
 * The project's main folder: for a task worktree, the folder that holds the shared `.git`; otherwise `cwd`.
 * Outside a git repository (or without git) it is `cwd`.
 */
export function mainFolder(exec: Exec, cwd: string): string {
  const r = exec('git', ['rev-parse', '--git-common-dir'], { cwd });
  const out = r.code === 0 ? r.stdout.trim() : '';
  if (!out) return cwd;
  const common = isAbsolute(out) ? out : resolve(cwd, out);
  // A normal repository: <main>/.git. Anything else (bare, odd layouts): stay where we are.
  return common.replace(/[\\/]+$/, '').endsWith('.git') ? dirname(common) : cwd;
}

export const taskLogDir = (main: string, taskId: string) => join(main, LOGS_DIR, taskId);

export const roleLogName = (round: number, role: string) => `${round}-${role}.log`;

/** `<round>-<role>.log` files in a task's log folder, by round. */
export function roleLogs(dir: string): { file: string; round: number; role: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => /^(\d+)-([a-z][a-z0-9-]*)\.log$/.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: m[0], round: Number(m[1]), role: m[2]! }))
    .sort((a, b) => a.round - b.round);
}

export interface PipelineLog {
  dir: string;
  /** One line of the kit (time-stamped) to pipeline.log; returns the line written. */
  write(line: string): string;
}

export function pipelineLog(main: string, taskId: string, now: () => Date, redact: (s: string) => string): PipelineLog {
  const dir = taskLogDir(main, taskId);
  return {
    dir,
    write(line) {
      mkdirSync(dir, { recursive: true });
      const text = `${now().toISOString().slice(11, 19)} ${redact(line)}`;
      appendFileSync(join(dir, PIPELINE_LOG), `${text}\n`);
      return text;
    },
  };
}
