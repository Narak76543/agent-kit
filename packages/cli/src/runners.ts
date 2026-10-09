/**
 * Runner adapters: how `run` starts the orchestrator agent non-interactively.
 * Commands are argv arrays (no shell), so prompts and paths with spaces or quotes are passed
 * exactly, on Windows too.
 */
import { KitError, type AgentConfig, type KitEnv } from '@tossana/agents-core';
import { versionOf, type Exec } from './exec.js';

export interface RunnerCommand {
  cmd: string;
  args: string[];
}

export interface RunnerAdapter {
  name: string;
  /** false = no headless mode (Antigravity): `run` prints instructions instead. */
  headless: boolean;
  isInstalled(): Promise<boolean>;
  buildCommand(opts: { agent: string; prompt: string; cwd: string }): RunnerCommand;
  installHint: string;
}

export const ORCHESTRATOR = 'orchestrator';

export const taskPrompt = (taskId: string) =>
  `Work on ClickUp task ${taskId}. Follow AGENTS.md and your agent instructions.`;

export function opencodeAdapter(exec: Exec, cwd: string): RunnerAdapter {
  return {
    name: 'opencode',
    headless: true,
    isInstalled: async () => versionOf(exec, 'opencode', cwd) !== null,
    // https://opencode.ai/docs/cli/ — `opencode run [message..]` with `--agent`. No `--auto`: the agent
    // files are default-deny with no "ask" rules, so nothing can wait for approval.
    buildCommand: ({ agent, prompt }) => ({ cmd: 'opencode', args: ['run', '--agent', agent, prompt] }),
    installHint: 'Install OpenCode: npm install -g opencode-ai  (then: opencode auth login)',
  };
}

/**
 * AGENT_CMD from .env, split like a shell would split it (quotes group words), then placeholders
 * are filled per argument: {agent}, {prompt}, and {taskId} (EKMONG_MOBILE's old AGENT_CMD).
 */
export function customAdapter(agentCmd: string | undefined, taskId: string): RunnerAdapter {
  return {
    name: 'custom',
    headless: true,
    isInstalled: async () => !!agentCmd?.trim(),
    buildCommand: ({ agent, prompt }) => {
      const words = splitCommand(agentCmd ?? '');
      if (!words.length) throw new KitError('AGENT_CMD is empty. Set it in .env for the custom runner.');
      if (!/\{(prompt|taskId)\}/.test(agentCmd!)) {
        throw new KitError('AGENT_CMD must contain {prompt} (or {taskId}) so the agent knows which task to run.');
      }
      const fill = (w: string) =>
        w.replaceAll('{agent}', agent).replaceAll('{prompt}', prompt).replaceAll('{taskId}', taskId);
      const [cmd, ...args] = words.map(fill);
      return { cmd: cmd!, args };
    },
    installHint: 'Add AGENT_CMD=... to .env, e.g. AGENT_CMD=opencode run --agent {agent} {prompt}',
  };
}

export function antigravityAdapter(): RunnerAdapter {
  return {
    name: 'antigravity',
    headless: false,
    isInstalled: async () => true,
    buildCommand: () => {
      throw new KitError('Antigravity has no headless runner');
    },
    installHint: '',
  };
}

export function adapterFor(config: AgentConfig, env: KitEnv, exec: Exec, cwd: string, taskId: string): RunnerAdapter {
  switch (config.pipeline.runner) {
    case 'opencode':
      return opencodeAdapter(exec, cwd);
    case 'custom':
      return customAdapter(env.AGENT_CMD, taskId);
    case 'antigravity':
      return antigravityAdapter();
    default:
      throw new KitError(`runner "${config.pipeline.runner}" is not supported yet. Use opencode or custom.`);
  }
}

/** Splits a command line into words. Double or single quotes group words; quotes are removed. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) throw new KitError('AGENT_CMD has an unclosed quote');
  if (inWord) words.push(current);
  return words;
}

/** For display only: quotes words with spaces or quotes so the line can be copied. */
export function formatCommand({ cmd, args }: RunnerCommand): string {
  return [cmd, ...args].map((w) => (/^[\w@%+=:,./\\-]+$/.test(w) ? w : `"${w.replace(/"/g, '\\"')}"`)).join(' ');
}
