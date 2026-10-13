/**
 * One run per project at a time, whether it was started from the CLI or the Local Console: a lock file with the
 * pid of the process that runs. A lock whose process is gone (crash, killed terminal) is taken over.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KitError } from '@tossana/agents-core';

export const RUN_LOCK = join('.agents', 'logs', 'run.lock');

export interface RunLock {
  release(): void;
}

interface LockInfo {
  pid: number;
  task?: string;
  startedAt?: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function readRunLock(cwd: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(cwd, RUN_LOCK), 'utf8')) as LockInfo;
    return Number.isInteger(info.pid) && alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

export function acquireRunLock(cwd: string, task: string | undefined, now = new Date()): RunLock {
  const file = join(cwd, RUN_LOCK);
  mkdirSync(join(cwd, '.agents', 'logs'), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, task, startedAt: now.toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, body, { flag: 'wx' });
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          rmSync(file, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = readRunLock(cwd);
      if (holder) {
        throw new KitError(
          `another run is already going in this project (pid ${holder.pid}${holder.task ? `, task ${holder.task}` : ''}, ` +
            `started ${holder.startedAt ?? '?'}). Wait for it or stop it first.`,
        );
      }
      rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  throw new KitError(`could not take the run lock (${RUN_LOCK}); try again`);
}
