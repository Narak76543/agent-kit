/**
 * Codex support (plan Phase 7 d). Formats from the Codex docs (checked 2026-10-12):
 * custom agents `.codex/agents/*.toml` (name, description, developer_instructions, sandbox_mode),
 * rules `.codex/rules/*.rules` (prefix_rule, forbidden > prompt > allow), config keys approval_policy /
 * sandbox_mode / mcp_servers, protected paths (.git, .agents, .codex stay read-only in workspace-write),
 * non-interactive `codex exec`. Codex reads `.codex/` only in projects the developer has marked as trusted.
 *
 * Kit-owned: `.codex/agents/<role>.toml`, `.codex/orchestrator.md`, `.codex/rules/tossana.rules`.
 * `.codex/config.toml` is written only when it does not exist (or is the kit's own); a user's file is never
 * changed: the kit prints the lines to add instead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FIGMA_MCP_URL, pipelineRoles, type AgentConfig, type PipelineRole } from '@tossana/agents-core';
import type { MergeResult } from './claude.js';
import { FIGMA_READ_TOOLS } from './figma.js';
import { splitCommand } from './runners.js';
import type { KitFile } from './templates.js';

export const CODEX_CONFIG = '.codex/config.toml';
export const CODEX_ORCHESTRATOR = '.codex/orchestrator.md';
export const CODEX_RULES = '.codex/rules/tossana.rules';

/** A TOML string: a multi-line literal string when possible (no escapes), else a basic string. */
export function tomlString(s: string): string {
  if (s.includes('\n') && !s.includes("'''")) return `'''\n${s}'''`;
  return JSON.stringify(s); // JSON string escapes are valid TOML basic-string escapes
}

function fromOpencode(content: string): { description: string; body: string } {
  const end = content.indexOf('\n---\n', 4);
  return {
    description: /^description: (.*)$/m.exec(content.slice(0, end))?.[1] ?? '',
    body: content.slice(end + 5).replace(/^\n+/, ''),
  };
}

const CODEX_NOTE = (role: PipelineRole) =>
  role.preset === 'read-only'
    ? [
        '> Codex: you run in a read-only sandbox, so you cannot write your comment draft. Give your full report as your',
        '> final answer; the orchestrator posts it for you. `tossana-agents clickup …` commands run outside the',
        '> sandbox (project rules), so reading the task and its comments works.',
        '',
      ]
    : [
        '> Codex: you run in the workspace-write sandbox. `git add` / `git commit` and `tossana-agents clickup …` run',
        '> outside it (project rules); `git push` and history rewrites are forbidden.',
        '',
      ];

export function codexKitFiles(config: AgentConfig, opencode: KitFile[], managedHeader: string): KitFile[] {
  const byPath = new Map(opencode.map((f) => [f.path, f.content]));
  const files: KitFile[] = [];
  const roles = pipelineRoles(config);

  for (const role of roles) {
    const { description, body } = fromOpencode(byPath.get(`.opencode/agents/${role.name}.md`)!);
    files.push({
      path: `.codex/agents/${role.name}.toml`,
      content: [
        managedHeader,
        `name = ${tomlString(role.name)}`,
        `description = ${tomlString(description)}`,
        `sandbox_mode = ${tomlString(role.preset === 'read-only' ? 'read-only' : 'workspace-write')}`,
        `developer_instructions = ${tomlString([...CODEX_NOTE(role), body].join('\n'))}`,
        '',
      ].join('\n'),
    });
  }

  const orchestrator = fromOpencode(byPath.get('.opencode/agents/orchestrator.md')!).body;
  const readOnly = roles.filter((r) => r.preset === 'read-only').map((r) => `\`${r.name}\``);
  files.push({
    path: CODEX_ORCHESTRATOR,
    content: [
      `<!-- ${managedHeader.replace(/^# /, '')} -->`,
      '# Orchestrator (Codex)',
      '',
      'You are the orchestrator in the main Codex session. Start the roles as Codex custom agents (defined in',
      '`.codex/agents/<role>.toml`), one at a time, in the order below; never in parallel (they share one working tree).',
      ...(readOnly.length
        ? [
            `${readOnly.join(', ')} run in a read-only sandbox and cannot write their comment draft: post their report`,
            'for them unchanged (write it to `.tossana/tmp/<taskId>-<role>.md` and run `cu comment <taskId> --file …`).',
          ]
        : []),
      '',
      orchestrator,
    ].join('\n'),
  });

  files.push({ path: CODEX_RULES, content: rulesFile(config, managedHeader) });
  return files;
}

const rule = (
  pattern: (string | string[])[],
  decision: 'allow' | 'forbidden',
  justification: string,
  match: string | string[],
) =>
  [
    'prefix_rule(',
    `    pattern = ${JSON.stringify(pattern).replace(/,/g, ', ')},`,
    `    decision = "${decision}",`,
    `    justification = ${JSON.stringify(justification)},`,
    `    match = [${[match]
      .flat()
      .map((m) => JSON.stringify(m))
      .join(', ')}],`,
    ')',
  ].join('\n');

/** Locked rules (forbidden) and the commands that must run outside the sandbox (allow). */
export function rulesFile(config: AgentConfig, managedHeader: string): string {
  const header = [
    managedHeader,
    '# Codex applies the most restrictive matching rule: forbidden > prompt > allow.',
    '# "allow" runs a command outside the sandbox: git writes to .git (read-only in the sandbox), ClickUp needs network.',
  ].join('\n');
  const out = [
    header,
    rule(['git', 'push'], 'forbidden', 'Agents never push. Only a human pushes.', 'git push origin task/T1'),
    rule(
      ['git', ['reset', 'rebase', 'merge', 'clean', 'switch', 'checkout']],
      'forbidden',
      'Agents never rewrite history or switch branches; tossana-agents run prepares the branch.',
      'git reset --hard',
    ),
    rule(['git', 'commit', '--amend'], 'forbidden', 'Agents never amend commits.', 'git commit --amend'),
    rule(['git', 'branch', ['-d', '-D', '--delete']], 'forbidden', 'Agents never delete branches.', 'git branch -D x'),
    rule(
      ['git', ['add', 'commit']],
      'allow',
      'Commits write to .git, which the sandbox keeps read-only.',
      'git add src/a.ts',
    ),
    rule(
      ['tossana-agents', 'clickup'],
      'allow',
      'ClickUp calls need network, and handoff notes go to .agents/ (read-only in the sandbox); the kit refuses Done.',
      ['tossana-agents clickup get T1', 'tossana-agents clickup handoff T1 --file .tossana/tmp/T1-coder.md'],
    ),
    rule(
      ['npx', 'tossana-agents', 'clickup'],
      'allow',
      'Same as tossana-agents clickup.',
      'npx tossana-agents clickup get T1',
    ),
  ];
  const install = config.commands.install ? splitCommand(config.commands.install) : [];
  if (install.length) {
    out.push(rule(install, 'allow', 'Installing packages needs network.', config.commands.install!));
  }
  return `${out.join('\n\n')}\n`;
}

/** The project config Codex needs (written only when absent or kit-owned). */
export function codexConfigText(config: AgentConfig, managedHeader: string): string {
  const lines = [
    managedHeader,
    '# Non-interactive runs: never ask, sandbox writes limited to the project (.git/.agents/.codex stay read-only).',
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
  ];
  if (config.figma.enabled) {
    lines.push(
      '',
      '# Figma MCP server, read-only tools only (each developer uses their own Figma login).',
      '[mcp_servers.figma]',
      `url = ${JSON.stringify(FIGMA_MCP_URL[config.figma.server])}`,
      `enabled_tools = [${FIGMA_READ_TOOLS.map((t) => JSON.stringify(t)).join(', ')}]`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function applyCodexConfig(cwd: string, config: AgentConfig, managedHeader: string): MergeResult {
  const file = join(cwd, CODEX_CONFIG);
  const wanted = codexConfigText(config, managedHeader);
  const ours = (text: string) => text.startsWith('# Managed by @tossana/agents');
  if (!config.tools.includes('codex')) return { path: CODEX_CONFIG, action: 'unchanged' };
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8');
    if (!ours(current)) {
      return {
        path: CODEX_CONFIG,
        action: 'manual',
        hint: `${CODEX_CONFIG} is yours, so the kit does not change it. Make sure it has:\n${wanted.split('\n').slice(1).join('\n')}`,
      };
    }
    if (current === wanted) return { path: CODEX_CONFIG, action: 'unchanged' };
    writeFileSync(file, wanted);
    return { path: CODEX_CONFIG, action: 'updated' };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, wanted);
  return { path: CODEX_CONFIG, action: 'added' };
}

/** True when ~/.codex/config.toml (or $CODEX_HOME) marks this project as trusted. */
export function codexTrusted(cwd: string, codexHome: string): boolean {
  const file = join(codexHome, 'config.toml');
  if (!existsSync(file)) return false;
  const norm = (p: string) => p.replace(/\\\\/g, '\\').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const target = norm(cwd);
  let inProject = false;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[projects\.(?:"(.+)"|'(.+)')\]$/.exec(line);
    if (header) {
      inProject = norm(header[1] ?? header[2]!) === target;
      continue;
    }
    if (line.startsWith('[')) inProject = false;
    else if (inProject && /^trust_level\s*=\s*["']trusted["']/.test(line)) return true;
  }
  return false;
}
