/**
 * Handoff files: `.agents/handoff/<taskId>.md`, append-only shared memory between agents
 * and between runs. Same format as EKMONG_MOBILE scripts/clickup.ts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KitError } from './errors.js';

export const HANDOFF_DIR = join('.agents', 'handoff');

/** Task IDs (normal or custom, e.g. 86abc123 or EKM-12) safe to use as a file name. */
export function isValidTaskId(taskId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(taskId);
}

export function handoffPath(cwd: string, taskId: string): string {
  if (!isValidTaskId(taskId)) throw new KitError(`invalid task id "${taskId}"`);
  return join(cwd, HANDOFF_DIR, `${taskId}.md`);
}

/** Appends one timestamped section. Creates the folder and file when needed. Returns the file path. */
export function appendHandoff(cwd: string, taskId: string, heading: string, text: string, now = new Date()): string {
  const file = handoffPath(cwd, taskId);
  mkdirSync(join(cwd, HANDOFF_DIR), { recursive: true });
  const header = existsSync(file) ? '' : `# Handoff log for task ${taskId}\n`;
  appendFileSync(file, `${header}\n## ${now.toISOString()} — ${heading}\n\n${text.replace(/\r\n/g, '\n').trim()}\n`);
  return file;
}

/** The whole handoff file, or `null` if there is none yet. */
export function readHandoff(cwd: string, taskId: string): string | null {
  const file = handoffPath(cwd, taskId);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}
