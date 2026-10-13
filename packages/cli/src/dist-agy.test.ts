/**
 * The BUILT CLI (dist/index.js) runs `antigravity check` against a fake agy on PATH. Unit tests import modules one
 * by one; only the bundle shows load-order bugs (an import cycle once made the check write to "undefined/…").
 * Skipped when the CLI has not been built (`pnpm build`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from './test-utils.test-helper.js';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

/** A fake agy: prints its version, or "pong" for every agent. */
const FAKE_AGY = `
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('1.3.3');
else console.log('pong');
`;

let root = '';
let dir = '';
let bin = '';

describe.skipIf(!existsSync(DIST))('built CLI: antigravity check', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tak dist '));
    dir = join(root, 'project');
    bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'agy.js'), FAKE_AGY);
    if (process.platform === 'win32') {
      writeFileSync(join(bin, 'agy.cmd'), '@node "%~dp0agy.js" %*\r\n');
    } else {
      writeFileSync(join(bin, 'agy'), `#!/bin/sh\nexec node "$(dirname "$0")/agy.js" "$@"\n`, { mode: 0o755 });
    }
    mkdirSync(dir);
    writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ ...CONFIG, tools: ['antigravity'] }));
    writeFileSync(join(dir, '.env'), 'CLICKUP_OWNER_USER_ID=777\n');
    execFileSync(process.execPath, [DIST, 'init', '--yes', '--no-doctor', '--list', 'L1'], {
      cwd: dir,
      encoding: 'utf8',
    });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('checks every agent and remembers the result in .tossana/tmp/agy-check.json', () => {
    const PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
    const r = spawnSync(process.execPath, [DIST, 'antigravity', 'check'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH, Path: PATH },
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('✓ orchestrator: pong');
    expect(r.stdout).toContain('✓ tester: pong');
    const saved = JSON.parse(readFileSync(join(dir, '.tossana', 'tmp', 'agy-check.json'), 'utf8')) as {
      agyVersion: string;
      agents: { ok: boolean }[];
    };
    expect(saved.agyVersion).toBe('1.3.3');
    expect(saved.agents).toHaveLength(4);
    expect(existsSync(join(dir, 'undefined'))).toBe(false);
  });
});
