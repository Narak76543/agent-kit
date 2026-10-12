/**
 * `tossana-agents guard`: the Claude Code PreToolUse hook. Reads the hook input (JSON on stdin) and blocks a
 * tool call that the running role may not make (exit code 2; the reason goes to stderr, Claude sees it).
 *
 * - `agent_type` names the role (set for subagents and for `claude --agent <role>`). Without it (a developer's
 *   own session) the guard allows everything: the kit never changes how people use Claude Code themselves.
 * - Fails closed: any error while checking an agent's call blocks it.
 * https://code.claude.com/docs/en/hooks
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '@tossana/agents-core';
import { SilentExit, type CliContext } from '../context.js';
import {
  LOCKED_COMMAND_PATTERNS,
  allPolicies,
  isProtectedPath,
  testFileMatchers,
  TMP_DIR,
  type RolePolicy,
} from '../presets.js';

export interface HookInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  agent_type?: string;
}

/** Tools any role may use without further checks. */
const ALWAYS_OK = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'TodoRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function registerGuardCommand(program: Command, ctx: CliContext): void {
  program
    .command('guard', { hidden: true })
    .description('Claude Code PreToolUse hook: blocks tool calls the running role may not make')
    .action(async () => {
      let input: HookInput = {};
      let reason: string | null;
      try {
        input = JSON.parse((await ctx.io.readStdin()) || '{}') as HookInput;
        reason = checkToolCall(input, ctx.cwd);
      } catch (e) {
        // Fail closed for agents; never block a developer's own session because of a kit problem.
        reason = input.agent_type ? `the kit guard could not check this call (${(e as Error).message})` : null;
      }
      if (reason) {
        ctx.io.err(`BLOCKED by the Tossana agent kit: ${reason}\n`);
        throw new SilentExit(2);
      }
    });
}

/** Returns why the call is blocked, or null when it is allowed. */
export function checkToolCall(input: HookInput, fallbackCwd: string): string | null {
  const cwd = input.cwd || fallbackCwd;
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  const roleName = input.agent_type;
  // A developer's own session (no agent): the kit does not get in the way.
  if (!roleName) return null;

  // ---------- locked rules (every agent) ----------
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(args.command ?? '');
    for (const { pattern, reason } of LOCKED_COMMAND_PATTERNS) if (pattern.test(command)) return reason;
  }
  const path = String(args.file_path ?? args.notebook_path ?? args.path ?? '');
  if (path && (tool === 'Read' || EDIT_TOOLS.has(tool)) && /(^|[\\/])\.env(\.[\w-]+)?$/.test(path)) {
    if (!(tool === 'Read' && /\.env\.example$/.test(path))) return 'agents never read or change .env files';
  }

  const policy = allPolicies(loadConfig(cwd)).get(roleName);
  if (!policy) return null; // an agent the kit does not manage (e.g. Claude's built-in Explore)

  if (ALWAYS_OK.has(tool)) return null;
  if (tool === 'Bash' || tool === 'PowerShell') return checkCommand(policy, String(args.command ?? ''));
  if (EDIT_TOOLS.has(tool)) return checkEdit(policy, cwd, path);
  if (tool === 'Agent' || tool === 'Task') {
    const target = String(args.subagent_type ?? '');
    return policy.subagents.includes(target) ? null : `${roleName} may not start the "${target}" agent`;
  }
  if (tool.startsWith('mcp__')) {
    return policy.mcpTools.includes(tool)
      ? null
      : `${roleName} may not use ${tool} (only read-only tools of its MCP servers)`;
  }
  return `${roleName} may not use the ${tool} tool (default deny)`;
}

/** Splits `a && b; c | d` into simple commands; each one must be allowed. */
const parts = (command: string) =>
  command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const startsWith = (command: string, prefix: string) => command === prefix || command.startsWith(`${prefix} `);

function checkCommand(policy: RolePolicy, command: string): string | null {
  for (const part of parts(command)) {
    const denied = policy.deny.find((p) => startsWith(part, p));
    if (denied) return `${policy.role} may never run "${denied}"`;
    if (!policy.commands.some((p) => startsWith(part, p))) {
      return `${policy.role} may not run "${part}". Allowed: ${policy.commands.join(', ')}`;
    }
  }
  return null;
}

function checkEdit(policy: RolePolicy, cwd: string, path: string): string | null {
  if (!path) return `${policy.role}: edit without a file path`;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs).split('\\').join('/');
  if (rel.startsWith('..') || isAbsolute(rel)) return `${policy.role} may only edit files inside the project`;
  const inTmp = rel.startsWith(`${TMP_DIR}/`);
  if (inTmp) return null;
  if (isProtectedPath(rel)) return `${policy.role} may not edit ${rel} (kit, git and secret files are protected)`;
  if (policy.edit === 'all') return null;
  if (policy.edit === 'tests') {
    const config = loadConfig(cwd);
    if (testFileMatchers(config).some((m) => m.test(rel))) return null;
    return `${policy.role} may edit test files only, not ${rel}`;
  }
  return `${policy.role} is read-only: it may only write its comment draft in ${TMP_DIR}/`;
}
