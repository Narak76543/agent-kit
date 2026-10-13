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

/**
 * The allow rules a headless run in this project needs.
 *
 * Tested against agy 1.3.3 with a throwaway agent (one command per session, see PROGRESS.md): a plain rule such as
 * `command(git log)` only matches that exact text, not `git log -n 5 --oneline`, and agents on Windows run
 * `npx.cmd` / `pnpm.cmd`. So every rule is an anchored `regex:` rule; the first word may end in `.cmd`; arguments may
 * not contain shell control characters (; & | < > ` $ or a line break), so nothing can be chained after an allowed
 * command. Nothing here matches push, amend, reset, rebase, branch deletion or checkout.
 */
export function antigravityRules(config: AgentConfig, kitCmd: string): string[] {
  const project = [config.commands.lint, config.commands.typecheck, config.commands.test]
    .map((c) => c?.trim())
    .filter((c): c is string => !!c);
  const kit = commandPattern(kitCmd);
  const rules = [
    `^${kit} clickup ${ARGS}*$`,
    `^${kit} run --task [A-Za-z0-9_-]+ --no-agent$`,
    `^git (status|diff|log|show|rev-parse)( ${ARGS}*)?$`,
    '^git branch( (-a|--all|-r|--show-current|--list))?$',
    `^git add ${ARGS}+$`,
    '^git commit -m "[^";&|<>\\x60$\\r\\n]+"$',
    ...project.map((c) => `^${commandPattern(c)}$`),
  ];
  return [...new Set(rules)].map((r) => `command(regex:${r})`);
}

/** Argument characters: anything but shell control characters (backtick written as \x60). */
const ARGS = '[^;&|<>\\x60$\\r\\n]';
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "pnpm lint" → "(pnpm|pnpm\.cmd) lint": the exact command, with the Windows .cmd shim allowed for the program. */
function commandPattern(command: string): string {
  const [program, ...rest] = command.trim().split(/\s+/);
  const p = escapeRegex(program!);
  return [`(${p}|${p}\\.cmd)`, ...rest.map(escapeRegex)].join(' ');
}

/**
 * Rules earlier kit versions added (plain prefixes; agy 1.3.3 matches them only as exact text, so they never let
 * the agents work). `antigravity permissions` replaces exactly these, nothing else.
 */
export function legacyAntigravityRules(config: AgentConfig, kitCmd: string): string[] {
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

export interface RulesChange {
  file: string;
  added: string[];
  /** Old kit rules being replaced (only rules the kit itself added before). */
  removed: string[];
}

/** What `addAntigravityRules` would change, without writing anything. */
export function planAntigravityRules(home: string, rules: string[], legacy: string[]): RulesChange {
  const file = agySettingsFile(home);
  const allow = readSettings(home)?.permissions?.allow ?? [];
  return {
    file,
    added: rules.filter((r) => !allow.includes(r)),
    removed: allow.filter((r) => legacy.includes(r) && !rules.includes(r)),
  };
}

/** Adds the missing rules and drops the old kit rules (a backup is made first). Nothing else changes. */
export function addAntigravityRules(
  home: string,
  rules: string[],
  now = new Date(),
  legacy: string[] = [],
): RulesChange & { backup: string | null } {
  const file = agySettingsFile(home);
  const exists = existsSync(file);
  const settings = exists ? readSettings(home) : {};
  if (!settings) throw new KitError(`${file} is not valid JSON; fix it first (agy reads the same file).`);
  const change = planAntigravityRules(home, rules, legacy);
  if (!change.added.length && !change.removed.length) return { ...change, backup: null };
  let backup: string | null = null;
  if (exists) {
    backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
  }
  const allow = (settings.permissions?.allow ?? []).filter((r) => !change.removed.includes(r));
  settings.permissions = { ...settings.permissions, allow: [...allow, ...change.added] };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { ...change, backup };
}
