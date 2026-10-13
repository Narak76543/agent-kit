/**
 * Writes kit-owned files for `init` and `update`:
 * - new or untouched files (hash matches the manifest) are written;
 * - files the person edited are shown as a diff and only replaced after confirmation (or --force);
 * - files that existed before the kit (no manifest entry) are backed up first in non-interactive mode;
 * - in AGENTS.md only the part above `<!-- PROJECT -->` is the kit's; the rest is never touched.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { CliContext } from './context.js';
import { projectPath, readManifest, sha256, writeManifest, type KitManifest } from './kit-manifest.js';
import type { Prompts } from './prompts.js';
import { PROJECT_MARKER, type KitFile } from './templates.js';
import { KIT_VERSION } from './version.js';

export type KitFileAction = 'created' | 'updated' | 'unchanged' | 'replaced' | 'kept' | 'removed';

export interface KitFileResult {
  path: string;
  action: KitFileAction;
  /** Where the old file was saved, when it was backed up. */
  backup?: string;
}

export interface ApplyOptions {
  /** Replace locally edited files without asking. */
  force?: boolean;
  /** null = non-interactive. */
  prompts: Prompts | null;
  /** Project section for a new AGENTS.md (below the marker). */
  projectSection: string;
}

const norm = (s: string) => `${s.replace(/\r\n/g, '\n').trimEnd()}\n`;

interface Current {
  /** The kit-owned text currently on disk, or null when there is none. */
  kitText: string | null;
  /** Rebuilds the whole file from a new kit text. */
  compose(kitText: string): string;
}

function readCurrent(ctx: CliContext, file: KitFile, projectSection: string): Current {
  const full = projectPath(ctx.cwd, file.path);
  // `raw` keeps the person's bytes (CRLF included) for the part the kit never owns.
  const raw = existsSync(full) ? readFileSync(full, 'utf8') : null;
  if (file.path !== 'AGENTS.md') return { kitText: raw, compose: (k) => k };

  if (raw === null)
    return { kitText: null, compose: (k) => `${norm(k)}\n${PROJECT_MARKER}\n\n${norm(projectSection)}` };
  const at = findMarker(raw);
  if (at < 0) {
    // AGENTS.md written before the kit: keep all of it, byte for byte, below the marker.
    return { kitText: null, compose: (k) => `${norm(k)}\n${PROJECT_MARKER}\n\n${raw}` };
  }
  const below = raw.slice(at + PROJECT_MARKER.length);
  return { kitText: raw.slice(0, at), compose: (k) => `${norm(k)}\n${PROJECT_MARKER}${below}` };
}

/** Index of the marker on a line of its own (the kit text mentions it inline), or -1. */
export function findMarker(text: string): number {
  const m = /^<!-- PROJECT -->[ \t]*\r?$/m.exec(text);
  return m ? m.index : -1;
}

export async function applyKitFiles(
  ctx: CliContext,
  files: KitFile[],
  options: ApplyOptions,
): Promise<KitFileResult[]> {
  const old = readManifest(ctx.cwd);
  const manifest: KitManifest = { kitVersion: KIT_VERSION, files: {} };
  const results: KitFileResult[] = [];
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');

  for (const file of files) {
    const full = projectPath(ctx.cwd, file.path);
    const current = readCurrent(ctx, file, options.projectSection);
    const desired = norm(file.content);
    const write = () => {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, current.compose(desired));
    };
    manifest.files[file.path] = sha256(desired);

    if (current.kitText === null) {
      write();
      results.push({ path: file.path, action: 'created' });
      continue;
    }
    const have = norm(current.kitText);
    if (have === desired) {
      results.push({ path: file.path, action: 'unchanged' });
      continue;
    }
    const recorded = old?.files[file.path];
    if (recorded && recorded === sha256(have)) {
      write();
      results.push({ path: file.path, action: 'updated' });
      continue;
    }

    // Edited locally, or a file that existed before the kit.
    const preKit = !recorded;
    let replace = options.force === true;
    if (!replace && options.prompts) {
      ctx.logger.info(
        ctx.logger.redact(
          createTwoFilesPatch(`${file.path} (yours)`, `${file.path} (kit v${KIT_VERSION})`, have, desired),
        ),
      );
      replace = await options.prompts.confirm(
        preKit
          ? `${file.path} already exists and was not written by the kit. Replace it with the kit version?`
          : `${file.path} was edited locally. Replace it with the kit version (your changes are lost)?`,
        preKit,
      );
    } else if (!replace && preKit) {
      replace = true; // non-interactive: back up and replace files the kit never managed
    }

    if (!replace) {
      if (recorded) manifest.files[file.path] = recorded; // still counts as "edited locally" next time
      results.push({ path: file.path, action: 'kept' });
      continue;
    }
    const backup = `.agents/kit/backup/${stamp}/${file.path}`;
    const backupFull = projectPath(ctx.cwd, backup);
    mkdirSync(dirname(backupFull), { recursive: true });
    writeFileSync(backupFull, readFileSync(full, 'utf8'));
    write();
    results.push({ path: file.path, action: 'replaced', backup });
  }

  // Files the kit wrote before but no longer needs (e.g. the skill changed): remove if untouched.
  for (const [path, hash] of Object.entries(old?.files ?? {})) {
    if (path in manifest.files) continue;
    const full = projectPath(ctx.cwd, path);
    if (existsSync(full) && sha256(readFileSync(full, 'utf8')) === hash) {
      rmSync(full);
      results.push({ path, action: 'removed' });
    } else if (existsSync(full)) {
      results.push({ path, action: 'kept' });
    }
  }

  writeManifest(ctx.cwd, manifest);
  return results;
}

/**
 * Antigravity agents moved from flat files (.agents/agents/<name>.md) to .agents/agents/<name>/agent.md, the layout the
 * Antigravity docs specify. Run before applyKitFiles: every flat file the kit wrote moves to the new path and its
 * manifest entry follows it, so an untouched file is updated as usual and an edited one stays "edited locally"
 * (kept unless --force, with a backup). Returns the moved paths. Files the kit did not write are left alone.
 */
export function migrateAntigravityAgents(cwd: string): string[] {
  const manifest = readManifest(cwd);
  if (!manifest) return [];
  const moved: string[] = [];
  const files: Record<string, string> = {};
  for (const [path, hash] of Object.entries(manifest.files)) {
    const m = /^\.agents\/agents\/([^/]+)\.md$/.exec(path);
    if (!m) {
      files[path] = hash;
      continue;
    }
    const target = `.agents/agents/${m[1]}/agent.md`;
    const from = projectPath(cwd, path);
    const to = projectPath(cwd, target);
    // Deleted by hand, or already at the new path: the old entry is just dropped.
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    files[target] = hash;
    moved.push(`${path} → ${target}`);
  }
  manifest.files = files;
  writeManifest(cwd, manifest);
  return moved;
}

/**
 * Comment drafts moved from .agents/tmp/ to .tossana/tmp/ (Codex keeps .agents/ read-only in its sandbox).
 * Moves leftover drafts once; returns how many files moved.
 */
export function migrateDraftsDir(cwd: string): number {
  const oldDir = join(cwd, '.agents', 'tmp');
  if (!existsSync(oldDir)) return 0;
  const newDir = join(cwd, '.tossana', 'tmp');
  mkdirSync(newDir, { recursive: true });
  let moved = 0;
  for (const name of readdirSync(oldDir)) {
    const target = join(newDir, name);
    if (!existsSync(target)) {
      renameSync(join(oldDir, name), target);
      moved++;
    }
  }
  if (readdirSync(oldDir).length === 0) rmSync(oldDir, { recursive: true });
  return moved;
}

export function printKitFileResults(ctx: CliContext, results: KitFileResult[]): void {
  for (const r of results) {
    if (r.action === 'unchanged') continue;
    const note =
      r.action === 'kept'
        ? ' (your version kept; run "tossana-agents update --force" to replace it)'
        : r.backup
          ? ` (old version saved to ${r.backup})`
          : '';
    ctx.logger.info(`  ${r.action.padEnd(8)} ${r.path}${note}`);
  }
  const unchanged = results.filter((r) => r.action === 'unchanged').length;
  if (unchanged) ctx.logger.info(`  ${unchanged} file(s) already up to date`);
}
