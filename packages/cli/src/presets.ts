/**
 * What each role may do, as data (plan Phase 7). OpenCode gets these as permission rules in the agent files;
 * Claude Code gets them through `tossana-agents guard` (a PreToolUse hook) and the run settings.
 * Locked rules apply to every role and cannot be changed by config, library or dashboard.
 */
import { pipelineRoles, type AgentConfig, type PipelineRole } from '@tossana/agents-core';
import { FIGMA_READ_TOOLS } from './figma.js';
import { TEST_GLOBS, testKind } from './template-vars.js';

export const KIT_PREFIXES = ['tossana-agents', 'npx tossana-agents'];
/** Folder for comment drafts (the only place read-only roles may write). */
export const TMP_DIR = '.tossana/tmp';

export interface RolePolicy {
  role: string;
  /** all = any project file except protected ones; tests = test files only; none = only comment drafts. */
  edit: 'all' | 'tests' | 'none';
  /** Allowed command prefixes. */
  commands: string[];
  /** Command prefixes this role may never run (on top of the locked rules). */
  deny: string[];
  /** Allowed MCP tool names as Claude Code calls them (mcp__<server>__<tool>). */
  mcpTools: string[];
  /** Roles this one may start (the orchestrator only). */
  subagents: string[];
}

const kit = (subcommands: string[]) => KIT_PREFIXES.flatMap((p) => subcommands.map((s) => `${p} clickup ${s}`));
const READ_TASK = kit(['get', 'comments', 'comment', 'handoff']);
const GIT_SAFE = ['git status', 'git diff', 'git log'];
const NO_HISTORY_REWRITE = [
  'git reset',
  'git rebase',
  'git merge',
  'git switch',
  'git checkout',
  'git branch -d',
  'git branch -D',
  'git branch --delete',
  'git commit --amend',
  'git clean',
];
const STATUS = kit(['status']);

/** Locked for every role: matched anywhere in a command. */
export const LOCKED_COMMAND_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+push\b/, reason: 'agents never push' },
  { pattern: /api\.clickup\.com/i, reason: 'agents talk to ClickUp only through the kit' },
  { pattern: /CLICKUP_API_TOKEN/, reason: 'agents never use the token directly' },
  { pattern: /(^|[\s/\\'"])\.env(\.[\w-]+)?(\s|$|['"])/, reason: 'agents never read .env files' },
  {
    pattern: /tossana-agents\s+clickup\s+status\s+\S+\s+.*\b(done|complete|closed)\b/i,
    reason: 'only a human sets Done/Complete/Closed',
  },
];

/** Paths no role may edit (project-relative, forward slashes). The comment drafts folder is the exception. */
export function isProtectedPath(rel: string): boolean {
  if (rel === TMP_DIR || rel.startsWith(`${TMP_DIR}/`)) return false;
  const base = rel.split('/').pop()!;
  return (
    /^\.env($|\.)/.test(base) ||
    base === 'agent.config.json' ||
    /(^|\/)\.(git|opencode|claude|codex|agents)(\/|$)/.test(rel)
  );
}

/** Quality-gate commands of the project (install only for coding roles). */
function projectCommands(config: AgentConfig, withInstall: boolean): string[] {
  const c = config.commands;
  return [withInstall ? c.install : undefined, c.lint, c.typecheck, c.test].filter((x): x is string => !!x);
}

function mcpToolsFor(role: PipelineRole): string[] {
  return role.mcp.includes('figma') ? FIGMA_READ_TOOLS.map((t) => `mcp__figma__${t}`) : [];
}

export function orchestratorPolicy(config: AgentConfig): RolePolicy {
  return {
    role: 'orchestrator',
    edit: 'none',
    commands: [
      ...kit(['']).map((c) => c.trimEnd()),
      'git status',
      'git log',
      'git diff',
      'git branch --show-current',
      'git rev-parse',
    ],
    deny: [],
    mcpTools: [],
    subagents: pipelineRoles(config).map((r) => r.name),
  };
}

export function rolePolicy(config: AgentConfig, role: PipelineRole): RolePolicy {
  const base = { role: role.name, mcpTools: mcpToolsFor(role), subagents: [] };
  switch (role.preset) {
    case 'edit-code':
      return {
        ...base,
        edit: 'all',
        commands: [
          ...projectCommands(config, true),
          ...GIT_SAFE,
          'git add',
          'git commit',
          'git branch --show-current',
          ...READ_TASK,
          ...kit(['subtask']),
        ],
        deny: [...STATUS, ...NO_HISTORY_REWRITE],
      };
    case 'edit-tests-only':
      return {
        ...base,
        edit: 'tests',
        commands: [...projectCommands(config, false), ...GIT_SAFE, 'git add', 'git commit', ...READ_TASK],
        deny: [...STATUS, ...NO_HISTORY_REWRITE, 'git add -A', 'git add .', 'git add --all'],
      };
    case 'read-only':
      return {
        ...base,
        edit: 'none',
        commands: ['git diff', 'git log', ...READ_TASK],
        deny: [...STATUS, ...kit(['subtask'])],
      };
  }
}

/** Every role's policy, by name (orchestrator included). */
export function allPolicies(config: AgentConfig): Map<string, RolePolicy> {
  const map = new Map<string, RolePolicy>([['orchestrator', orchestratorPolicy(config)]]);
  for (const role of pipelineRoles(config)) map.set(role.name, rolePolicy(config, role));
  return map;
}

/** Test-file globs (OpenCode style: `*` matches across folders) as regexes. */
export function testFileMatchers(config: AgentConfig): RegExp[] {
  return TEST_GLOBS[testKind(config.project.type)]!.map(
    (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`),
  );
}
