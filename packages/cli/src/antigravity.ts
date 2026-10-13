/**
 * Antigravity CLI (`agy`) headless runs: what has to be true on this machine.
 *
 * - The project folder must be a trusted workspace (`trustedWorkspaces` in ~/.gemini/antigravity-cli/settings.json),
 *   or agy does not load its `.agents/agents/` (checked with agy 1.3.3).
 * - In print mode a command that needs approval is soft-denied: the run goes on and exits 0
 *   (https://antigravity.google/docs/cli/headless). So the commands the agents need must be allowed with
 *   `permissions.allow` rules. agy only reads them from the user's global settings file (no project file,
 *   https://antigravity.google/docs/permissions?tab=cli), so the kit adds them there, after a confirmation.
 *
 * The rules are narrow prefixes: the kit's clickup commands, read-only git, `git add` and `git commit`, and the
 * project's lint/typecheck/test commands. Never `git push`, never `command(*)`, never --dangerously-skip-permissions.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KitError, type AgentConfig } from '@tossana/agents-core';

export const agySettingsFile = (home: string) => join(home, '.gemini', 'antigravity-cli', 'settings.json');

/** How agents call the kit in this project (same rule as init: a Node project uses its local install). */
export const kitCommand = (cwd: string) =>
  existsSync(join(cwd, 'package.json')) ? 'npx tossana-agents' : 'tossana-agents';

interface AgySettings {
  trustedWorkspaces?: string[];
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  [key: string]: unknown;
}

/** The allow rules a headless run in this project needs (prefix rules, word by word). */
export function antigravityRules(config: AgentConfig, kitCmd: string): string[] {
  const project = [config.commands.lint, config.commands.typecheck, config.commands.test]
    .map((c) => c?.trim())
    .filter((c): c is string => !!c);
  return [
    `command(${kitCmd} clickup)`,
    'command(git status)',
    'command(git diff)',
    'command(git log)',
    'command(git show)',
    'command(git branch --show-current)',
    'command(git rev-parse)',
    'command(git add)',
    'command(git commit -m)',
    ...project.map((c) => `command(${c})`),
  ];
}

/** Rules in the user's settings that would let an agent push or run anything (agy has no per-agent deny here). */
const TOO_BROAD = [/^command\(\*\)$/, /^command\(git\)$/, /^command\(git push/, /^unsandboxed\(git push/];

export interface AgyState {
  /** The settings file exists and is readable JSON. */
  found: boolean;
  trusted: boolean;
  missing: string[];
  /** Existing allow rules that are broader than the kit wants (e.g. command(git), command(*)). */
  tooBroad: string[];
}

function readSettings(home: string): AgySettings | null {
  const file = agySettingsFile(home);
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as AgySettings;
  } catch {
    return null;
  }
}

const samePath = (a: string, b: string) =>
  a
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase() ===
  b
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();

export function antigravityState(home: string, cwd: string, rules: string[]): AgyState {
  const settings = readSettings(home);
  const allow = settings?.permissions?.allow ?? [];
  return {
    found: settings !== null,
    trusted: (settings?.trustedWorkspaces ?? []).some((w) => samePath(w, cwd)),
    missing: rules.filter((r) => !allow.includes(r)),
    tooBroad: allow.filter((r) => TOO_BROAD.some((re) => re.test(r))),
  };
}

/** Why a headless run cannot work yet, with the fix; null when it can. */
export function antigravityProblem(state: AgyState, kitCmd: string): string | null {
  if (!state.trusted) {
    return (
      'this folder is not a trusted Antigravity workspace, so agy does not load the agents here. ' +
      'Run "agy" once in this folder and choose to trust it.'
    );
  }
  if (state.missing.length) {
    return (
      `Antigravity would quietly refuse the commands the agents need (${state.missing.length} rule(s) missing). ` +
      `Allow them with: ${kitCmd} antigravity permissions`
    );
  }
  return null;
}

/** Adds the missing rules to the user's agy settings (a backup is made first). Nothing is removed. */
export function addAntigravityRules(
  home: string,
  rules: string[],
  now = new Date(),
): { file: string; backup: string | null; added: string[] } {
  const file = agySettingsFile(home);
  const exists = existsSync(file);
  const settings = exists ? readSettings(home) : {};
  if (!settings) throw new KitError(`${file} is not valid JSON; fix it first (agy reads the same file).`);
  const allow = settings.permissions?.allow ?? [];
  const added = rules.filter((r) => !allow.includes(r));
  if (!added.length) return { file, backup: null, added };
  let backup: string | null = null;
  if (exists) {
    backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
  }
  settings.permissions = { ...settings.permissions, allow: [...allow, ...added] };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, backup, added };
}
