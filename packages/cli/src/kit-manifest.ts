/**
 * `.agents/kit/manifest.json` records every kit-owned file `init`/`update` wrote, with the
 * sha256 of what was written. `update` uses it to tell untouched files from local edits;
 * `doctor` uses it to check the files exist and match the installed kit version.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MANIFEST_PATH = '.agents/kit/manifest.json';

export interface KitManifest {
  kitVersion: string;
  /** Project-relative POSIX path → sha256 of the content the kit wrote. */
  files: Record<string, string>;
}

export const sha256 = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

/** Project-relative POSIX path → absolute OS path. */
export const projectPath = (cwd: string, posixPath: string) => join(cwd, ...posixPath.split('/'));

export function readManifest(cwd: string): KitManifest | null {
  const file = projectPath(cwd, MANIFEST_PATH);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<KitManifest>;
    if (typeof data.kitVersion !== 'string' || typeof data.files !== 'object' || !data.files) return null;
    return { kitVersion: data.kitVersion, files: data.files };
  } catch {
    return null;
  }
}

export function writeManifest(cwd: string, manifest: KitManifest): void {
  const file = projectPath(cwd, MANIFEST_PATH);
  mkdirSync(dirname(file), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, `${JSON.stringify({ kitVersion: manifest.kitVersion, files: sorted }, null, 2)}\n`);
}
