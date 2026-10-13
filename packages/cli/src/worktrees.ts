/**
 * One git worktree per task (plan Phase 10, step 4): `<parent>/<repo>-tasks/<taskId>` on `task/<id>`, so agents work
 * there and the developer's own folder is never touched.
 *
 * - Created from the local base branch (`pipeline.baseBranch`; not origin: a clone's origin may not have the kit).
 * - A task branch with commits of its own is reused as it is; one with no own commits (left by a failed run) is
 *   moved to the base branch — nothing is lost, and it gets the current kit and agent files.
 * - `.env` (git-ignored), the task's handoff notes and the agy check result are copied in; the install command runs.
 * Nothing is ever deleted except a worktree folder the user asks to clean (branches are always kept).
 */
import { copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ENV_FILE, KitError, isValidTaskId, type AgentConfig } from '@tossana/agents-core';
import type { CliContext } from './context.js';
import { TMP_DIR } from './paths.js';
import { splitCommand } from './runners.js';

export const worktreesRoot = (cwd: string) => join(dirname(resolve(cwd)), `${basename(resolve(cwd))}-tasks`);
export const worktreePath = (cwd: string, taskId: string) => join(worktreesRoot(cwd), taskId);

const INSTALL_TIMEOUT_MS = 20 * 60_000;

function git(ctx: CliContext, args: string[], cwd = ctx.cwd) {
  const r = ctx.exec('git', args, { cwd, timeoutMs: 120_000 });
  return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.error?.message || '').trim() };
}

/** Real path when it exists: git prints /private/var/… on macOS where the kit has /var/… (a symlink). */
const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
const samePath = (a: string, b: string) =>
  real(a).replace(/\\/g, '/').toLowerCase() === real(b).replace(/\\/g, '/').toLowerCase();

interface GitWorktree {
  path: string;
  branch: string | null;
}

export function gitWorktrees(ctx: CliContext): GitWorktree[] {
  const out: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  for (const line of git(ctx, ['worktree', 'list', '--porcelain']).out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null };
      out.push(cur);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
  }
  return out;
}

export interface PreparedWorktree {
  path: string;
  branch: string;
  /** created = new folder; reused = the folder was there already. */
  action: 'created' | 'reused';
  /** The task branch had no commits of its own and was moved to the base branch. */
  movedToBase: boolean;
}

/** The task's worktree, ready for a run (see the file comment). */
export function prepareWorktree(
  ctx: CliContext,
  config: AgentConfig,
  taskId: string,
  log: (s: string) => void,
): PreparedWorktree {
  if (!isValidTaskId(taskId)) throw new KitError(`invalid task id "${taskId}"`);
  const base = config.pipeline.baseBranch;
  const branch = `${config.pipeline.branchPrefix}${taskId}`;
  const path = worktreePath(ctx.cwd, taskId);
  if (!git(ctx, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]).ok) {
    throw new KitError(`the base branch "${base}" does not exist here. Set pipeline.baseBranch in agent.config.json.`);
  }
  const branchExists = git(ctx, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const own = branchExists ? Number(git(ctx, ['rev-list', '--count', `${base}..${branch}`]).out || '0') : 0;
  const existing = gitWorktrees(ctx).find((w) => samePath(w.path, path));
  const elsewhere = gitWorktrees(ctx).find((w) => w.branch === branch && !samePath(w.path, path));
  if (elsewhere) {
    throw new KitError(
      `${branch} is checked out in ${elsewhere.path}. Switch that folder to another branch (e.g. git switch ${base}) and try again.`,
    );
  }

  let movedToBase = false;
  if (existing) {
    if (existing.branch !== branch)
      throw new KitError(`${path} is a worktree for ${existing.branch ?? 'no branch'}, not ${branch}.`);
    // No own commits and nothing uncommitted: bring it up to the base branch (a fast-forward, nothing is lost).
    const dirty = git(ctx, ['status', '--porcelain', '--untracked-files=no'], path).out;
    if (!own && !dirty) {
      const before = git(ctx, ['rev-parse', 'HEAD'], path).out;
      git(ctx, ['merge', '--ff-only', '--quiet', base], path);
      movedToBase = git(ctx, ['rev-parse', 'HEAD'], path).out !== before;
      if (movedToBase) log(`[worktree] ${branch} had no commits of its own: moved it to ${base}`);
    }
  } else {
    mkdirSync(worktreesRoot(ctx.cwd), { recursive: true });
    const args = !branchExists
      ? ['worktree', 'add', '-b', branch, path, base]
      : own === 0
        ? ['worktree', 'add', '-B', branch, path, base] // no own commits: move it to the base (lossless)
        : ['worktree', 'add', path, branch];
    const r = git(ctx, args);
    if (!r.ok) throw new KitError(`could not create the worktree ${path}: ${r.err}`);
    movedToBase = branchExists && own === 0;
    if (movedToBase) log(`[worktree] ${branch} had no commits of its own: moved it to ${base}`);
  }

  // Local files git does not carry: the token (.env), earlier handoff notes, the agy check result.
  for (const rel of [
    ENV_FILE,
    join('.agents', 'handoff', `${taskId}.md`),
    join(...TMP_DIR.split('/'), 'agy-check.json'),
  ]) {
    const from = join(ctx.cwd, rel);
    const to = join(path, rel);
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }

  if (!existing) {
    const install = config.commands.install?.trim();
    if (install) {
      const [cmd, ...args] = splitCommand(install);
      log(`[worktree] ${install}`);
      const r = ctx.exec(cmd!, args, { cwd: path, timeoutMs: INSTALL_TIMEOUT_MS });
      if (r.code !== 0) {
        throw new KitError(
          `"${install}" failed in ${path}:\n${(r.stderr || r.stdout || r.error?.message || '').trim().split(/\r?\n/).slice(-8).join('\n')}`,
        );
      }
    }
  }
  log(`[worktree] ${existing ? 'using' : 'created'} ${path} (${branch})`);
  return { path, branch, action: existing ? 'reused' : 'created', movedToBase };
}

export interface WorktreeInfo {
  taskId: string;
  path: string;
  branch: string | null;
  /** Tracked files with uncommitted changes. */
  dirty: boolean;
  /** Commits on the branch that are not on the base branch. */
  ahead: number;
  /** The branch is fully in the base branch (merged, or never had own commits). */
  merged: boolean;
}

export function listWorktrees(ctx: CliContext, config: AgentConfig): WorktreeInfo[] {
  const root = worktreesRoot(ctx.cwd);
  const base = config.pipeline.baseBranch;
  return gitWorktrees(ctx)
    .filter((w) => samePath(dirname(w.path), root))
    .map((w) => {
      const dirty = !!git(ctx, ['status', '--porcelain', '--untracked-files=no'], w.path).out;
      const ahead = w.branch ? Number(git(ctx, ['rev-list', '--count', `${base}..${w.branch}`]).out || '0') : 0;
      return { taskId: basename(w.path), path: w.path, branch: w.branch, dirty, ahead, merged: ahead === 0 };
    });
}

/** Removes a task worktree folder (the branch stays). Refuses uncommitted changes unless `force`. */
export function removeWorktree(ctx: CliContext, info: WorktreeInfo, force = false): void {
  if (info.dirty && !force) {
    throw new KitError(`${info.path} has uncommitted changes. Commit them, or remove it anyway with --force.`);
  }
  const r = git(ctx, ['worktree', 'remove', ...(force ? ['--force'] : []), info.path]);
  if (!r.ok) throw new KitError(`could not remove ${info.path}: ${r.err}`);
}
