/**
 * Runner adapters: how `run` starts the orchestrator agent non-interactively.
 * Commands are argv arrays (no shell), so prompts and paths with spaces or quotes are passed
 * exactly, on Windows too.
 */
import { CLAUDE_RUN_SETTINGS } from './claude.js';
import { CODEX_ORCHESTRATOR } from './codex.js';
import { KitError, type AgentConfig, type KitEnv } from '@tossana/agents-core';
import { homedir } from 'node:os';
import { agyCheckProblem, currentAgyCheck, runAgyCheck } from './agy-check.js';
import { antigravityProblem, antigravityRules, antigravityState, kitCommand, packageScripts } from './antigravity.js';
import type { OutputFormat } from './agent-stream.js';
import { versionOf, type Exec } from './exec.js';

export interface RunnerCommand {
  cmd: string;
  args: string[];
}

export interface BuildOptions {
  agent: string;
  prompt: string;
  cwd: string;
  /** Live, machine-readable output (the kit's pipeline renders it for the logs): see `streamFormat`. */
  stream?: boolean;
  /** The role may not edit files (Codex: read-only sandbox). */
  readOnly?: boolean;
}

export interface RunnerAdapter {
  name: string;
  /** false = no headless mode: `run` prints instructions instead. */
  headless: boolean;
  isInstalled(): Promise<boolean>;
  buildCommand(opts: BuildOptions): RunnerCommand;
  /** What the command prints with `stream: true` (default: readable text, passed through). */
  streamFormat?: OutputFormat;
  installHint: string;
  /**
   * Why the agent cannot do its work on this machine yet (with the fix), or null. Checked before anything changes.
   * `live`: may start the tool to check it (a real run); without it only cheap checks run (dry run).
   */
  preflight?(opts?: { live?: boolean; log?: (s: string) => void }): string | null;
}

export const ORCHESTRATOR = 'orchestrator';

/** Names the agent profile, whose skills are listed in the run entry of the handoff file. */
const profileNote = (taskId: string, profileName?: string) =>
  profileName
    ? ` Agent profile: "${profileName}": the coding and review roles also use the skills listed in the latest run ` +
      `entry of .agents/handoff/${taskId}.md.`
    : '';

export const taskPrompt = (taskId: string, profileName?: string) =>
  `Work on ClickUp task ${taskId}. Follow AGENTS.md and your agent instructions.${profileNote(taskId, profileName)}`;

/** Prompt for one role of the kit's pipeline: everything else is in the brief file. */
export const rolePrompt = (taskId: string, role: string, round: number, brief: string, profileName?: string) =>
  `You are the ${role} for ClickUp task ${taskId}, round ${round}. Read your brief first: ${brief}. Then follow ` +
  `AGENTS.md and your agent instructions.${profileNote(taskId, profileName)}`;

/** Prompt for `run --resume`: continue where the previous tool stopped, never restart the task. */
/** The owner's feedback as the first, top-priority instruction of a new round (feedback loop). */
const feedbackNote = (feedback?: string) =>
  feedback
    ? `TOP PRIORITY: the owner sent the task back with this feedback: """${feedback.replace(/"""/g, '"')}""". Start a ` +
      `new round at the coder with this feedback as its first instruction, then the normal review and test steps. `
    : '';

export const resumePrompt = (
  taskId: string,
  previous: string,
  baseBranch: string,
  profileName?: string,
  feedback?: string,
) =>
  feedbackNote(feedback) +
  `Resume ClickUp task ${taskId}; it was being worked on with ${previous}. Do not restart the task. First read ` +
  `.agents/handoff/${taskId}.md, the latest agent comment (tossana-agents clickup comments ${taskId}) and ` +
  `git log ${baseBranch}..HEAD, then continue from that point and round. If the last turn has no agent comment ` +
  `(the tool stopped mid-turn), treat that turn as unfinished and redo it. The STARTED comment for this resume is ` +
  `already posted and the status is already set: do not post another STARTED comment or reset the status. ` +
  `Follow AGENTS.md and your agent instructions.${profileNote(taskId, profileName)}`;

export function opencodeAdapter(exec: Exec, cwd: string): RunnerAdapter {
  return {
    name: 'opencode',
    headless: true,
    isInstalled: async () => versionOf(exec, 'opencode', cwd) !== null,
    // https://opencode.ai/docs/cli/ — `opencode run [message..]` with `--agent`. No `--auto`: the agent
    // files are default-deny with no "ask" rules, so nothing can wait for approval. `--dir` because
    // OpenCode prefers an inherited PWD (Git Bash, `--cwd`) over the process cwd and would then run in,
    // and load the agents of, the wrong folder (seen with OpenCode 1.18.35 on Windows).
    buildCommand: ({ agent, prompt, cwd }) => ({
      cmd: 'opencode',
      args: ['run', '--agent', agent, '--dir', cwd, prompt],
    }),
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

/**
 * Claude Code, headless: `claude -p <prompt> --agent orchestrator` (https://code.claude.com/docs/en/headless).
 * `--permission-mode dontAsk` denies anything that would prompt, so a run never waits for a person;
 * `--settings` adds the kit's allow/deny rules for this run only. Per-role limits come from the guard hook.
 */
export function claudeCodeAdapter(exec: Exec, cwd: string): RunnerAdapter {
  return {
    name: 'claude-code',
    headless: true,
    isInstalled: async () => versionOf(exec, 'claude', cwd) !== null,
    // stream-json needs --verbose in print mode; the plain text mode prints only the final answer.
    buildCommand: ({ agent, prompt, stream }) => ({
      cmd: 'claude',
      args: [
        '-p',
        prompt,
        '--agent',
        agent,
        '--permission-mode',
        'dontAsk',
        '--settings',
        CLAUDE_RUN_SETTINGS,
        ...(stream ? ['--output-format', 'stream-json', '--verbose'] : []),
      ],
    }),
    streamFormat: 'claude-stream',
    installHint: 'Install Claude Code (https://code.claude.com/docs/en/setup), then run "claude" once to log in.',
  };
}

/**
 * Codex, headless: `codex exec` (https://learn.chatgpt.com/docs/non-interactive-mode). Codex has no --agent flag,
 * so the prompt points the main session at the orchestrator's or the role's instructions, and the sandbox follows
 * the role (read-only for the reviewer). Approval "never": nothing waits for a person; git writes and ClickUp calls
 * run outside the sandbox via .codex/rules/tossana.rules.
 */
export function codexAdapter(exec: Exec, cwd: string): RunnerAdapter {
  return {
    name: 'codex',
    headless: true,
    isInstalled: async () => versionOf(exec, 'codex', cwd) !== null,
    buildCommand: ({ agent, prompt, readOnly }) => ({
      cmd: 'codex',
      args: [
        'exec',
        '--sandbox',
        readOnly ? 'read-only' : 'workspace-write',
        '-c',
        'approval_policy=never',
        agent === ORCHESTRATOR
          ? `${prompt} You are the orchestrator: read ${CODEX_ORCHESTRATOR} and follow it exactly.`
          : `${prompt} Your role instructions are the developer_instructions in .codex/agents/${agent}.toml: read ` +
            'them and follow them exactly.',
      ],
    }),
    installHint:
      'Install Codex (npm install -g @openai/codex), then run "codex" once to log in and trust this project.',
  };
}

/**
 * Antigravity CLI, headless: `agy -p <prompt> --agent orchestrator` (https://antigravity.google/docs/cli/headless).
 * The orchestrator is `.agents/agents/orchestrator/agent.md`. No --dangerously-skip-permissions: the commands the agents
 * need are allowed by narrow rules in the user's agy settings (see antigravity.ts); anything else is refused.
 * --print-timeout: agy's own limit (5 minutes by default in print mode) set to the kit's run timeout.
 */
export function antigravityAdapter(
  exec: Exec,
  cwd: string,
  options: { home: string; config: AgentConfig; now?: () => Date },
): RunnerAdapter {
  const kitCmd = kitCommand(cwd);
  return {
    name: 'antigravity',
    headless: true,
    isInstalled: async () => versionOf(exec, 'agy', cwd) !== null,
    // --add-dir: agy then loads this folder's agents and runs allowed commands without the folder being trusted
    // (checked with agy 1.3.3), so task worktrees work without touching the user's trust list.
    buildCommand: ({ agent, prompt, stream }) => ({
      cmd: 'agy',
      args: [
        '-p',
        prompt,
        '--agent',
        agent,
        '--add-dir',
        cwd,
        '--print-timeout',
        `${options.config.pipeline.timeoutMinutes}m`,
        ...(stream ? ['--output-format', 'stream-json'] : []),
      ],
    }),
    streamFormat: 'agy-stream',
    installHint: 'Install the Antigravity CLI (agy) from https://antigravity.google, then run "agy" once to log in.',
    preflight: ({ live = false, log } = {}) => {
      const setup = antigravityProblem(
        antigravityState(options.home, cwd, antigravityRules(options.config, kitCmd, packageScripts(cwd))),
        kitCmd,
      );
      if (setup) return setup;
      // Can agy start every agent (tool names)? Remembered per agy version and agent files.
      const ctx = { exec, cwd, now: options.now ?? (() => new Date()) };
      if (currentAgyCheck(ctx)) return null;
      if (!live) {
        return (
          'the agents are not checked with this agy version yet. Run: ' +
          `${kitCmd} antigravity check (a real run checks first: one short model call per agent)`
        );
      }
      log?.('[run] checking that agy can start every agent ("reply pong", once per agy version and agent files)');
      const problem = agyCheckProblem(runAgyCheck(ctx, log));
      return problem ? `agy cannot start these agents: ${problem}` : null;
    },
  };
}

export function adapterFor(
  config: AgentConfig,
  env: KitEnv,
  exec: Exec,
  cwd: string,
  taskId: string,
  home: string = homedir(),
  now?: () => Date,
): RunnerAdapter {
  switch (config.pipeline.runner) {
    case 'opencode':
      return opencodeAdapter(exec, cwd);
    case 'custom':
      return customAdapter(env.AGENT_CMD, taskId);
    case 'antigravity':
      return antigravityAdapter(exec, cwd, { home, config, now });
    case 'claude-code':
      return claudeCodeAdapter(exec, cwd);
    case 'codex':
      return codexAdapter(exec, cwd);
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
