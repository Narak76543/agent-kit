/**
 * Golden files: the exact kit files generated for a few fixed configs. They prove that refactors (custom roles,
 * per-tool generators) leave the default output byte-identical. To accept an intended change, run
 * `UPDATE_GOLDEN=1 pnpm vitest run packages/cli/src/golden.test.ts` and review the diff in git.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@tossana/agents-core';
import { templateVars } from './template-vars.js';
import { kitFiles } from './templates.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '__golden__');

const base = {
  version: 1,
  clickup: { listId: 'L1', statuses: { human: 'ready for review' } },
};

export const GOLDEN_CASES: Record<string, { config: object; kitCmd: string; packageManager: string | null }> = {
  'react-native': {
    config: {
      ...base,
      project: { name: 'ekmong-mobile', type: 'react-native', skill: 'mobile-master' },
      commands: { install: 'pnpm install', lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' },
    },
    kitCmd: 'npx tossana-agents',
    packageManager: 'pnpm',
  },
  'react-native-figma': {
    config: {
      ...base,
      project: { name: 'ekmong-mobile', type: 'react-native', skill: 'mobile-master' },
      commands: { install: 'pnpm install', lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' },
      figma: { enabled: true },
    },
    kitCmd: 'npx tossana-agents',
    packageManager: 'pnpm',
  },
  'flutter-no-commands': {
    config: { ...base, project: { name: 'shop_app', type: 'flutter', skill: 'flutter-master' } },
    kitCmd: 'tossana-agents',
    packageManager: null,
  },
};

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe('golden kit files', () => {
  for (const [name, c] of Object.entries(GOLDEN_CASES)) {
    it(`${name}: generated files match __golden__/${name}`, () => {
      const config = parseConfig(c.config);
      const vars = templateVars(config, { kitCmd: c.kitCmd, packageManager: c.packageManager });
      const generated = Object.fromEntries(kitFiles(config, vars).map((f) => [f.path, f.content]));
      const dir = join(GOLDEN, name);
      if (process.env.UPDATE_GOLDEN) {
        rmSync(dir, { recursive: true, force: true });
        for (const [path, content] of Object.entries(generated)) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), content);
        }
      }
      expect(generated).toEqual(files(dir));
    });
  }
});
