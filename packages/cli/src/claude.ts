/**
 * Claude Code support (plan Phase 7 c). Formats from https://code.claude.com/docs/en/sub-agents,
 * /permissions, /hooks and /headless.
 *
 * Kit-owned (in the manifest, replaced by `update`):
 * - `.claude/agents/<role>.md`: one subagent per role plus the orchestrator (run as the main agent with `--agent`);
 *   the instructions are the same text as the OpenCode agents.
 * - `.claude/tossana-run.settings.json`: allow + deny rules, passed with `--settings` by `tossana-agents run`
 *   only, so a developer's own Claude sessions in the project are not changed.
 * Merged (only the kit's own entries are added or removed; the user's settings stay):
 * - `.claude/settings.json`: one PreToolUse hook that runs `tossana-agents guard` (per-role limits).
 * - `CLAUDE.md`: an `@AGENTS.md` import line.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipelineRoles, type AgentConfig, type PipelineRole } from '@tossana/agents-core';
import type { KitFile } from './templates.js';
import { allPolicies } from './presets.js';

export const CLAUDE_RUN_SETTINGS = '.claude/tossana-run.settings.json';
export const CLAUDE_SETTINGS = '.claude/settings.json';
const GUARD_MARK = 'tossana-agents guard';

const FILE_TOOLS: Record<PipelineRole['preset'], string[]> = {
  'edit-code': ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  'edit-tests-only': ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  // Write only for the comment draft in .tossana/tmp/ (the guard blocks everything else).
  'read-only': ['Read', 'Grep', 'Glob', 'Write', 'Bash'],
};

/** Splits a rendered OpenCode agent into its description and instruction body. */
function fromOpencode(content: string): { description: string; body: string } {
  const end = content.indexOf('\n---\n', 4);
  const frontmatter = content.slice(0, end);
  const description = /^description: (.*)$/m.exec(frontmatter)?.[1] ?? '';
  return { description, body: content.slice(end + 5) };
}

const yamlString = (s: string) => JSON.stringify(s);

/**
 * Claude Code agent files, built from the already rendered OpenCode agents (same instructions).
 * `managedHeader` is the YAML comment line the kit puts in every managed file.
 */
export function claudeKitFiles(config: AgentConfig, opencode: KitFile[], managedHeader: string): KitFile[] {
  const byPath = new Map(opencode.map((f) => [f.path, f.content]));
  const policies = allPolicies(config);
  const files: KitFile[] = [];
  const agent = (name: string, tools: string[]) => {
    const source = byPath.get(`.opencode/agents/${name}.md`);
    if (!source) return;
    const { description, body } = fromOpencode(source);
    files.push({
      path: `.claude/agents/${name}.md`,
      content: [
        '---',
        managedHeader,
        `name: ${name}`,
        `description: ${yamlString(description)}`,
        `tools: ${tools.join(', ')}`,
        'model: inherit',
        '---',
        body,
      ].join('\n'),
    });
  };

  const roles = pipelineRoles(config);
  agent('orchestrator', ['Read', 'Grep', 'Glob', 'Write', 'Bash', `Agent(${roles.map((r) => r.name).join(', ')})`]);
  for (const role of roles) agent(role.name, [...FILE_TOOLS[role.preset], ...policies.get(role.name)!.mcpTools]);

  files.push({ path: CLAUDE_RUN_SETTINGS, content: `${JSON.stringify(runSettings(config), null, 2)}\n` });
  return files;
}

/** Permissions for `claude -p … --permission-mode dontAsk`: the union of what roles may do; the guard narrows it. */
export function runSettings(config: AgentConfig): object {
  const commands = new Set<string>();
  const mcp = new Set<string>();
  for (const p of allPolicies(config).values()) {
    p.commands.forEach((c) => commands.add(c));
    p.mcpTools.forEach((t) => mcp.add(t));
  }
  return {
    permissions: {
      allow: ['Edit', 'Write', ...[...commands].flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]), ...mcp],
      deny: [
        'Bash(git push)',
        'Bash(git push *)',
        'Read(./.env)',
        'Read(./.env.*)',
        'Read(**/.env)',
        'Edit(**/.env)',
        'Edit(**/.env.*)',
      ],
    },
  };
}

type Json = Record<string, unknown>;
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

export interface MergeResult {
  path: string;
  action: 'added' | 'updated' | 'removed' | 'unchanged' | 'manual';
  hint?: string;
}

/**
 * Adds (or removes, when Claude Code is not used) the guard hook in `.claude/settings.json`. Only hook groups
 * whose command contains "tossana-agents guard" are the kit's; everything else in the file is kept.
 */
export function applyClaudeSettings(cwd: string, config: AgentConfig, kitCmd: string): MergeResult[] {
  const use = config.tools.includes('claude-code');
  return [
    mergeHook(cwd, use ? `${kitCmd} guard` : null),
    use ? ensureClaudeMd(cwd) : { path: 'CLAUDE.md', action: 'unchanged' },
  ];
}

function mergeHook(cwd: string, command: string | null): MergeResult {
  const file = join(cwd, CLAUDE_SETTINGS);
  let data: Json = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(stripBom(readFileSync(file, 'utf8'))) as Json;
    } catch {
      return command
        ? {
            path: CLAUDE_SETTINGS,
            action: 'manual',
            hint: `${CLAUDE_SETTINGS} is not plain JSON, so the kit does not change it. Add a PreToolUse hook (matcher "*") with the command: ${command}`,
          }
        : { path: CLAUDE_SETTINGS, action: 'unchanged' };
    }
  } else if (!command) {
    return { path: CLAUDE_SETTINGS, action: 'unchanged' };
  }

  const hooks = (data.hooks ?? {}) as Record<string, HookGroup[]>;
  const groups = hooks.PreToolUse ?? [];
  const ours = (g: HookGroup) => (g.hooks ?? []).some((h) => h.command?.includes(GUARD_MARK));
  const others = groups.filter((g) => !ours(g));
  const current = groups.filter(ours);
  const wanted: HookGroup[] = command ? [{ matcher: '*', hooks: [{ type: 'command', command }] }] : [];
  if (JSON.stringify(current) === JSON.stringify(wanted)) return { path: CLAUDE_SETTINGS, action: 'unchanged' };

  const next = [...others, ...wanted];
  if (next.length) hooks.PreToolUse = next;
  else delete hooks.PreToolUse;
  if (Object.keys(hooks).length) data.hooks = hooks;
  else delete data.hooks;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { path: CLAUDE_SETTINGS, action: !command ? 'removed' : current.length ? 'updated' : 'added' };
}

/** Claude Code reads CLAUDE.md, not AGENTS.md: import it (https://code.claude.com/docs/en/memory). */
function ensureClaudeMd(cwd: string): MergeResult {
  const file = join(cwd, 'CLAUDE.md');
  const line = '@AGENTS.md';
  if (!existsSync(file)) {
    writeFileSync(file, `${line}\n`);
    return { path: 'CLAUDE.md', action: 'added' };
  }
  const text = readFileSync(file, 'utf8');
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return { path: 'CLAUDE.md', action: 'unchanged' };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(file, `${text}${text.endsWith('\n') ? '' : eol}${eol}${line}${eol}`);
  return { path: 'CLAUDE.md', action: 'updated' };
}
