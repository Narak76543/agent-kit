/**
 * Is an agent tool installed on this machine, and set up in this project? Used by `agents list` and the Local
 * Console, so people see before a run whether an agent's tool can be used here.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig } from '@tossana/agents-core';
import { RUNNER_FILES } from './commands/resume.js';
import type { CliContext } from './context.js';
import { versionOf } from './exec.js';

/** The program each tool runs as. Antigravity is an IDE: it cannot be checked from here. */
const PROGRAM: Record<string, string | undefined> = { opencode: 'opencode', 'claude-code': 'claude', codex: 'codex' };

export interface ToolStatus {
  tool: string;
  /** null = cannot be checked (Antigravity is started from its IDE). */
  installed: boolean | null;
  version: string | null;
  /** The kit generated this tool's files in the project (agent.config.json "tools" + the orchestrator file). */
  setUp: boolean;
  /** The kit can start it headless (everything but Antigravity). */
  headless: boolean;
}

export function toolStatus(ctx: CliContext, config: AgentConfig | null, tool: string): ToolStatus {
  const program = PROGRAM[tool];
  const version = program ? versionOf(ctx.exec, program, ctx.cwd) : null;
  const need = RUNNER_FILES[tool];
  return {
    tool,
    installed: program ? version !== null : null,
    version,
    setUp: !!config && !!need && config.tools.includes(need.tool as never) && existsSync(join(ctx.cwd, need.file)),
    headless: tool !== 'antigravity',
  };
}

/** Status of every tool, checked once each (version checks start a program). */
export function toolStatuses(
  ctx: CliContext,
  config: AgentConfig | null,
  tools: readonly string[],
): Map<string, ToolStatus> {
  return new Map([...new Set(tools)].map((t) => [t, toolStatus(ctx, config, t)]));
}
