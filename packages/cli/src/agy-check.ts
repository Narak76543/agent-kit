/**
 * Live check of the Antigravity agents: can agy actually start each of them?
 *
 * agy refuses an agent whose `tools:` list names a tool it does not know, while it builds the agent and before any
 * model call: `failed to resolve components: unknown component: tool "command_status" not found in registry`
 * (agy 1.3.3). A wrong name in a subagent only shows up when the orchestrator starts it, in the middle of a task.
 * So each agent is started once with a trivial prompt ("reply pong"): the orchestrator as it is, and each subagent
 * as a temporary main-agent copy with the same tools (agy only lets --agent pick main agents).
 *
 * A passing check is remembered for this agy version and these exact agent files (.tossana/tmp/agy-check.json), so
 * `run` only checks again after an update or an agy upgrade. Each check is one tiny model call per agent.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliContext } from './context.js';

/** What the check needs from the CLI context (the run adapter has only these). */
export type CheckCtx = Pick<CliContext, 'exec' | 'cwd' | 'now'>;
import { versionOf } from './exec.js';
import { TMP_DIR } from './presets.js';

const AGENTS_DIR = join('.agents', 'agents');
const CACHE = `${TMP_DIR}/agy-check.json`;
const PROMPT = 'Reply with the single word pong.';
/** Long enough for one short model answer; a hung agent is stopped by our own timeout below. */
const PER_AGENT_TIMEOUT_MS = 150_000;

export interface AgentCheck {
  agent: string;
  ok: boolean;
  /** Why it failed (agy's error, e.g. the unknown tool), or empty. */
  problem: string;
}

export interface AgyCheck {
  agyVersion: string;
  /** sha256 of every .agents/agents/<name>/agent.md, so any change makes the result stale. */
  filesHash: string;
  at: string;
  agents: AgentCheck[];
}

/** The workspace agents (folder names under .agents/agents/ with an agent.md). */
export function antigravityAgents(cwd: string): string[] {
  const dir = join(cwd, AGENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'agent.md')))
    .map((d) => d.name)
    .sort((a, b) => (a === 'orchestrator' ? -1 : b === 'orchestrator' ? 1 : a.localeCompare(b)));
}

function filesHash(cwd: string, agents: string[]): string {
  const h = createHash('sha256');
  for (const a of agents) h.update(`${a}\n`).update(readFileSync(join(cwd, AGENTS_DIR, a, 'agent.md'), 'utf8'));
  return h.digest('hex');
}

export function readAgyCheck(cwd: string): AgyCheck | null {
  try {
    return JSON.parse(readFileSync(join(cwd, ...CACHE.split('/')), 'utf8')) as AgyCheck;
  } catch {
    return null;
  }
}

/** The remembered result, if it is for this agy version and these agent files; else null (check again). */
export function currentAgyCheck(ctx: CheckCtx): AgyCheck | null {
  const cached = readAgyCheck(ctx.cwd);
  const version = versionOf(ctx.exec, 'agy', ctx.cwd);
  if (!cached || !version || cached.agyVersion !== version) return null;
  return cached.filesHash === filesHash(ctx.cwd, antigravityAgents(ctx.cwd)) ? cached : null;
}

/** A copy of the agent that agy can start as the main agent: same tools and settings, a trivial body. */
function probeAgent(source: string, name: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const front = /^(?:#[^\n]*\n)*---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!front) throw new Error('no YAML front matter');
  const fields = front[1]!
    .split(/\r?\n/)
    .filter((l) => !/^(name|mainAgent|subagent|description)\s*:/.test(l) && !l.startsWith('#'));
  return [
    '---',
    `name: ${name}`,
    'description: tossana-agents tool check',
    'mainAgent: true',
    'subagent: false',
    ...fields,
    '---',
    PROMPT,
    '',
  ].join('\n');
}

/** Starts each agent once with "reply pong" and remembers the result. */
export function runAgyCheck(ctx: CheckCtx, log: (s: string) => void = () => {}): AgyCheck {
  const version = versionOf(ctx.exec, 'agy', ctx.cwd);
  if (!version) throw new Error('agy is not installed');
  const agents = antigravityAgents(ctx.cwd);
  const tmp = mkdtempSync(join(tmpdir(), 'tossana-agy-check-'));
  const results: AgentCheck[] = [];
  try {
    for (const agent of agents) {
      const source = readFileSync(join(ctx.cwd, AGENTS_DIR, agent, 'agent.md'), 'utf8');
      // The orchestrator is checked as it is (it is a main agent); subagents as a main-agent copy.
      const name = agent === 'orchestrator' ? agent : `zz-tossana-check-${agent}`;
      let args: string[];
      if (agent === 'orchestrator') {
        args = ['-p', PROMPT, '--agent', name, '--print-timeout', '2m'];
      } else {
        const dir = join(tmp, AGENTS_DIR, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'agent.md'), probeAgent(source, name));
        args = ['-p', PROMPT, '--agent', name, '--add-dir', tmp, '--print-timeout', '2m'];
      }
      log(`  ${agent} …`);
      const r = ctx.exec('agy', args, { cwd: ctx.cwd, timeoutMs: PER_AGENT_TIMEOUT_MS });
      const out = `${r.stdout}\n${r.stderr}`;
      const unknown = /unknown component: tool "([^"]+)" not found/.exec(out);
      const ok = !r.error && r.code === 0 && /\bpong\b/i.test(r.stdout);
      results.push({
        agent,
        ok,
        problem: ok
          ? ''
          : unknown
            ? `agy does not know the tool "${unknown[1]}" (in .agents/agents/${agent}/agent.md)`
            : r.error
              ? `agy did not answer: ${r.error.message}`
              : `agy exit ${r.code ?? 'killed'}: ${out.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300) || 'no answer'}`,
      });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const check: AgyCheck = {
    agyVersion: version,
    filesHash: filesHash(ctx.cwd, agents),
    at: ctx.now().toISOString(),
    agents: results,
  };
  if (results.every((r) => r.ok)) {
    mkdirSync(join(ctx.cwd, ...TMP_DIR.split('/')), { recursive: true });
    writeFileSync(join(ctx.cwd, ...CACHE.split('/')), `${JSON.stringify(check, null, 2)}\n`);
  }
  return check;
}

export const agyCheckProblem = (check: AgyCheck) =>
  check.agents
    .filter((a) => !a.ok)
    .map((a) => `${a.agent}: ${a.problem}`)
    .join('; ') || null;
