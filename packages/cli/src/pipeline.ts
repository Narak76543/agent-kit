/**
 * The kit's pipeline loop (plan Phase 11): `run` and `watch` start each role as its own headless agent and decide
 * the next step in code, so the order is guaranteed and every role can be watched in its own log.
 *
 *   STARTED → [planners, once] → round 1..maxRounds: coder(s) → checks (reviewer, tester)
 *   CHANGES_NEEDED / FAIL → next round at the first coder with the issues · all passed → ready for review (PASS)
 *   out of rounds → ready for review (NEEDS_HUMAN) · a role reports NEEDS_HUMAN → stop, status unchanged
 *
 * Rules the orchestrator agent used to apply by judgement:
 * - a role's result is its ClickUp comment for this run; else its comment draft in .tossana/tmp/ (posted by the
 *   kit); else the `[AGENT: …] [RESULT: …]` report in its final answer (posted by the kit);
 * - no result = a failed round; the same role without a result twice in a row = NEEDS_HUMAN (no burnt rounds);
 * - a coding role that leaves no new commit, or uncommitted changes, = a failed round.
 * Statuses and the orchestrator's comments are set by the kit; the agents never set a status.
 * The AI orchestrator stays available with `run --ai-orchestrator` (and /start-task in the IDE).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendHandoff,
  formatAgentComment,
  parseAgentComment,
  pipelineRoles,
  statusForRole,
  withBy,
  type AgentComment,
  type AgentConfig,
  type AgentIssue,
  type AgentResult,
  type ClickUpClient,
  type ClickUpComment,
  type PipelineRole,
} from '@tossana/agents-core';
import { FINISHED_MARK, RUN_MARK, roleLogName, type PipelineLog } from './agent-logs.js';
import type { AgentRun } from './agent-process.js';
import { extractReport, type OutputFormat } from './agent-stream.js';
import type { CliContext } from './context.js';
import { TMP_DIR } from './paths.js';
import { rolePrompt } from './runners.js';

export type PipelineClient = Pick<ClickUpClient, 'getComments' | 'postComment' | 'notify' | 'setStatus'>;

/** Where a run starts: a round, a position in that round's roles, and what the first role must know. */
export interface StartPoint {
  round: number;
  /** Index into the round's roles (coding roles, then checks). Past the end = the round already passed. */
  index: number;
  /** Run the planning roles first (only before any plan exists). */
  planning: boolean;
  /** Issues the first coding role fixes (from the previous round). */
  issues: AgentIssue[];
  issuesFrom: string | null;
  /** The owner's feedback: the top-priority instruction of this round. */
  feedback?: string;
}

export interface PipelineOptions {
  taskId: string;
  taskName: string;
  start: StartPoint;
  /** A new run: post STARTED and set the first status (a resume has posted its own STARTED comment). */
  postStart: boolean;
  /** `[BY: …]` of the kit's comments and of reports the kit posts for a role. */
  by: string;
  profileName?: string;
  ownerUserId: string;
}

export interface PipelineDeps {
  client: PipelineClient;
  git(args: string[]): { ok: boolean; out: string; err: string };
  /** Output format of the role commands (stream formats also get a raw .jsonl log). */
  format: OutputFormat;
  /** Starts one role's agent with this prompt and waits for it. */
  runRole(role: PipelineRole, prompt: string, logs: { log: string; raw?: string }): Promise<AgentRun>;
  log: PipelineLog;
}

export interface PipelineResult {
  result: 'PASS' | 'NEEDS_HUMAN' | 'INTERRUPTED';
  round: number;
  note: string;
}

/** Same role without a result this many times in a row: stop with NEEDS_HUMAN. */
const MAX_MISSING = 2;

const ok = (role: PipelineRole, result: AgentResult) =>
  role.kind === 'plan'
    ? result === 'PLANNED'
    : role.kind === 'code'
      ? result === 'DONE_CODING'
      : result === 'APPROVED' || result === 'PASS';

/** The results a role reports, as the brief shows them. */
const expected = (role: PipelineRole) =>
  role.kind === 'plan'
    ? 'PLANNED'
    : role.kind === 'code'
      ? 'DONE_CODING'
      : role.preset === 'read-only'
        ? 'APPROVED | CHANGES_NEEDED'
        : 'PASS | FAIL';

const issue = (text: string): AgentIssue => ({ location: null, text });
const issueLine = (i: AgentIssue) => `- ${i.location ? `${i.location} - ` : ''}${i.text}`;
const firstLine = (s: string) => s.split('\n')[0]!.trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function parsedComments(comments: ClickUpComment[]): AgentComment[] {
  return comments.map((c) => parseAgentComment(c.comment_text ?? '')).filter((c): c is AgentComment => c !== null);
}

/** The roles in run order: planners (once), then each round's coding roles and checks. */
export function roleOrder(config: AgentConfig) {
  const roles = pipelineRoles(config);
  const planners = roles.filter((r) => r.kind === 'plan');
  const round = [...roles.filter((r) => r.kind === 'code'), ...roles.filter((r) => r.kind === 'check')];
  return { planners, round };
}

export const freshStart = (config: AgentConfig): StartPoint => ({
  round: 1,
  index: 0,
  planning: roleOrder(config).planners.length > 0,
  issues: [],
  issuesFrom: null,
});

/**
 * Where a resumed run continues, from the agents' comments: after the last role that finished, or (after a
 * CHANGES_NEEDED / FAIL / NEEDS_HUMAN) the next round at the first coder with those issues. A role that was
 * interrupted before it reported is simply run again. Feedback starts a new round at the coder.
 */
export function resumePoint(config: AgentConfig, comments: ClickUpComment[], feedback?: string): StartPoint {
  const { planners, round: sequence } = roleOrder(config);
  const parsed = parsedComments(comments);
  const maxRound = Math.max(0, ...parsed.map((c) => c.round ?? 0));
  const planned = planners.every((p) => parsed.some((c) => c.agent === p.name && c.result === 'PLANNED'));
  const planning = planners.length > 0 && !planned;
  if (feedback) return { round: maxRound + 1, index: 0, planning, issues: [], issuesFrom: null, feedback };

  const last = [...parsed].reverse().find((c) => sequence.some((r) => r.name === c.agent));
  if (!last) return { round: Math.max(1, maxRound), index: 0, planning, issues: [], issuesFrom: null };
  const at = sequence.findIndex((r) => r.name === last.agent);
  const round = last.round ?? Math.max(1, maxRound);
  if (ok(sequence[at]!, last.result)) return { round, index: at + 1, planning: false, issues: [], issuesFrom: null };
  return {
    round: round + 1,
    index: 0,
    planning: false,
    issues: last.issues.length ? last.issues : [issue(firstLine(last.summary) || `${last.agent} ${last.result}`)],
    issuesFrom: last.agent,
  };
}

/** The plans written by the planning roles so far (their latest PLANNED comments). */
function plansFrom(comments: AgentComment[]): string[] {
  const latest = new Map<string, AgentComment>();
  for (const c of comments) if (c.result === 'PLANNED') latest.set(c.agent, c);
  return [...latest.values()].map((c) => [`From the ${c.agent}: ${c.summary}`, ...c.issues.map(issueLine)].join('\n'));
}

export const briefPath = (taskId: string, round: number, role: string) =>
  `${TMP_DIR}/${taskId}-r${round}-${role}-brief.md`;

/** What the orchestrator used to tell each role, as a file (long multi-line prompts break on Windows). */
export function briefText(
  config: AgentConfig,
  o: {
    taskId: string;
    taskName: string;
    role: PipelineRole;
    round: number;
    lastRound: number;
    issues: AgentIssue[];
    issuesFrom: string | null;
    feedback?: string;
    plans: string[];
  },
): string {
  const { taskId: id, role } = o;
  const docs = config.clickup.docs.ids.length ? ` Specs: \`${config.clickup.docs.outDir}/INDEX.md\`.` : '';
  const lines = [
    `# Brief: ${role.name}, task ${id}, round ${o.round}`,
    '',
    `- Task: ${id}${o.taskName ? ` — ${o.taskName}` : ''}`,
    `- Round: ${o.round} (at most ${o.lastRound})`,
    `- Branch: \`${config.pipeline.branchPrefix}${id}\` (already checked out; never switch branches)`,
    `- Context: \`.agents/context/${id}/INDEX.md\` (task, comments, links) and \`.agents/handoff/${id}.md\` ` +
      `(what happened before).${docs}`,
    '- The kit started you and sets the ClickUp statuses: never set one yourself.',
  ];
  if (o.feedback) {
    lines.push('', '## Owner feedback (top priority)', '', o.feedback.trim());
  }
  if (o.issues.length) {
    const title =
      role.kind === 'code'
        ? `## Fix these issues (from the ${o.issuesFrom ?? 'previous round'})`
        : `## Issues found in the previous round (by the ${o.issuesFrom ?? 'checks'}): check they are fixed`;
    lines.push('', title, '', ...o.issues.map(issueLine));
  }
  if (o.plans.length && role.kind !== 'plan') lines.push('', '## Plan', '', ...o.plans);
  lines.push(
    '',
    '## Report',
    '',
    `Post your comment as your instructions say, with this first line, and give the same text as your final answer:`,
    '',
    '```',
    `[AGENT: ${role.name}] [RESULT: ${expected(role)}] [ROUND: ${o.round}]`,
    '```',
    '',
    'If you cannot post it, your final answer is enough: the kit posts it for you.',
  );
  return `${lines.join('\n')}\n`;
}

export async function runPipeline(
  ctx: CliContext,
  config: AgentConfig,
  opts: PipelineOptions,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const id = opts.taskId;
  const { planners, round: sequence } = roleOrder(config);
  const say = (line: string) => ctx.logger.info(`[pipeline] ${deps.log.write(line)}`);
  const start = opts.start;
  const lastRound = start.feedback
    ? start.round + config.pipeline.maxRounds - 1
    : Math.max(config.pipeline.maxRounds, start.round);
  const missing = new Map<string, number>();
  let status: string | null = null;
  let finished = false;

  const setStatus = async (key: PipelineRole['status'] | 'human') => {
    const name = statusForRole(config, key);
    if (name === status) return;
    await deps.client.setStatus(id, name);
    status = name;
    say(`status → "${name}"`);
  };
  const post = async (text: string, heading = 'ClickUp comment') => {
    const stamped = withBy(text, opts.by);
    await deps.client.postComment(id, stamped);
    appendHandoff(ctx.cwd, id, heading, stamped, ctx.now());
  };
  const finish = async (
    result: 'PASS' | 'NEEDS_HUMAN',
    round: number,
    summary: string,
    issues: AgentIssue[],
    toHuman: boolean,
  ): Promise<PipelineResult> => {
    if (toHuman) await setStatus('human');
    const text = withBy(
      formatAgentComment({ agent: 'orchestrator', result, round, summary, issues, next: 'human' }),
      opts.by,
    );
    await deps.client.notify(id, text, opts.ownerUserId);
    appendHandoff(ctx.cwd, id, 'Owner notified', text, ctx.now());
    appendHandoff(ctx.cwd, id, 'Notes', `Run finished: ${result}, rounds used ${round}.`, ctx.now());
    say(`${FINISHED_MARK} ${result} (round ${round}): ${firstLine(summary)}`);
    finished = true;
    return { result, round, note: firstLine(summary) };
  };

  deps.log.write(`${RUN_MARK} ${id}: round ${start.round}${start.feedback ? ' (owner feedback)' : ''}`);
  try {
    const comments = await deps.client.getComments(id);
    const plans = plansFrom(parsedComments(comments));
    const firstRole = (start.planning ? planners[0] : sequence[start.index]) ?? sequence[0]!;
    if (opts.postStart) {
      await setStatus(firstRole.status);
      await post(
        formatAgentComment({
          agent: 'orchestrator',
          result: 'STARTED',
          round: start.round,
          summary: `Starting task on branch ${config.pipeline.branchPrefix}${id}. Each role runs as its own agent.`,
          next: firstRole.name,
        }),
      );
    }

    /** Runs one role and finds its result; null = no result; 'stop' = interrupted. */
    const step = async (
      role: PipelineRole,
      round: number,
      known: { issues: AgentIssue[]; issuesFrom: string | null; feedback?: string },
    ): Promise<AgentComment | null | 'stop'> => {
      await setStatus(role.status);
      const brief = briefPath(id, round, role.name);
      mkdirSync(join(ctx.cwd, ...TMP_DIR.split('/')), { recursive: true });
      writeFileSync(
        join(ctx.cwd, ...brief.split('/')),
        briefText(config, { ...known, taskId: id, taskName: opts.taskName, role, round, lastRound, plans }),
      );
      const before = new Set((await deps.client.getComments(id)).map((c) => String(c.id)));
      const logName = roleLogName(round, role.name);
      const log = join(deps.log.dir, logName);
      const raw = deps.format === 'text' ? undefined : log.replace(/\.log$/, '.jsonl');
      if (existsSync(log)) writeFileSync(log, `\n===== run again ${ctx.now().toISOString()} =====\n`, { flag: 'a' });
      say(`round ${round}: ${role.name} started (log: ${logName})`);
      const startedAt = Date.now();
      const run = await deps.runRole(role, rolePrompt(id, role.name, round, brief, opts.profileName), { log, raw });
      if (run.stopped === 'interrupted' || run.stopped === 'aborted') {
        say(`round ${round}: ${role.name} stopped`);
        return 'stop';
      }
      const found = await collectResult(ctx, deps, post, id, role, run, before, startedAt);
      const exit = run.stopped === 'timeout' ? 'timed out' : `exit ${run.code ?? 'killed'}`;
      say(
        found
          ? `round ${round}: ${role.name} ${found.comment.result} (${found.source}, ${exit})` +
              (found.comment.round !== null && found.comment.round !== round
                ? ` [reported round ${found.comment.round}]`
                : '')
          : `round ${round}: ${role.name} gave no result (no comment, no draft, no report; ${exit})`,
      );
      return found?.comment ?? null;
    };

    /** Counts a missing result; returns the NEEDS_HUMAN finish on the second one in a row. */
    const noResult = async (role: PipelineRole, round: number) => {
      const n = (missing.get(role.name) ?? 0) + 1;
      missing.set(role.name, n);
      if (n < MAX_MISSING) return null;
      return await finish(
        'NEEDS_HUMAN',
        round,
        `The ${role.name} gave no result ${n} times in a row; stopped without using the remaining rounds.`,
        [issue(`${role.name}: no comment and no [AGENT: ${role.name}] report; see .agents/logs/${id}/`)],
        false,
      );
    };

    // ---------- planning (once, before round 1) ----------
    if (start.planning) {
      for (const p of planners) {
        for (;;) {
          const r = await step(p, start.round, { issues: [], issuesFrom: null, feedback: start.feedback });
          if (r === 'stop') return interrupted(start.round);
          if (!r) {
            const stop = await noResult(p, start.round);
            if (stop) return stop;
            continue;
          }
          missing.set(p.name, 0);
          if (r.result === 'NEEDS_HUMAN') return await finish('NEEDS_HUMAN', start.round, r.summary, r.issues, false);
          plans.push([`From the ${p.name}: ${r.summary}`, ...r.issues.map(issueLine)].join('\n'));
          break;
        }
      }
    }

    // ---------- rounds ----------
    let issues = start.issues;
    let issuesFrom = start.issuesFrom;
    let index = start.index;
    let lastCheck: AgentComment | null = null;
    for (let round = start.round; round <= lastRound; round++) {
      const feedback = round === start.round ? start.feedback : undefined;
      let failed: { issues: AgentIssue[]; from: string } | null = null;
      for (const role of sequence.slice(index)) {
        const head = deps.git(['rev-parse', 'HEAD']).out;
        const r = await step(role, round, { issues, issuesFrom, feedback });
        if (r === 'stop') return interrupted(round);
        if (!r) {
          const stop = await noResult(role, round);
          if (stop) return stop;
          failed = { issues: [issue(`the ${role.name} gave no result in round ${round}`)], from: role.name };
          break;
        }
        missing.set(role.name, 0);
        if (r.result === 'NEEDS_HUMAN') return await finish('NEEDS_HUMAN', round, r.summary, r.issues, false);
        if (!ok(role, r.result)) {
          failed = { issues: r.issues.length ? r.issues : [issue(firstLine(r.summary))], from: role.name };
          break;
        }
        const problem = gitProblem(deps, role, head, round);
        if (problem) {
          say(`round ${round}: ${role.name}: ${problem} → failed round`);
          failed = { issues: [issue(problem)], from: role.name };
          break;
        }
        if (role.kind === 'check') lastCheck = r;
      }
      index = 0;
      if (!failed) {
        const summary =
          `${sequence.length > 1 ? 'Every check passed' : 'Done'} in round ${round}` +
          `${lastCheck ? ` (${lastCheck.agent}: ${clip(firstLine(lastCheck.summary), 120)})` : ''}. ` +
          `Branch ${config.pipeline.branchPrefix}${id} (local, not pushed).`;
        return await finish('PASS', round, summary, lastCheck?.issues ?? [], true);
      }
      issues = failed.issues;
      issuesFrom = failed.from;
      say(`round ${round} failed (${failed.from}): ${issues.length} issue(s) → back to ${sequence[0]!.name}`);
    }
    return await finish(
      'NEEDS_HUMAN',
      lastRound,
      `${lastRound} rounds without passing every check. Branch ${config.pipeline.branchPrefix}${id} has the latest attempt.`,
      issues,
      true,
    );
  } finally {
    if (!finished) say(`${FINISHED_MARK} STOPPED`);
  }

  function interrupted(round: number): PipelineResult {
    return { result: 'INTERRUPTED', round, note: 'stopped; it resumes from the last finished role' };
  }
}

/** The "no new commit" rule for coding roles, and no uncommitted changes from any role that may edit. */
function gitProblem(deps: PipelineDeps, role: PipelineRole, head: string, round: number): string | null {
  if (role.preset === 'read-only') return null;
  const dirty = deps.git(['status', '--porcelain', '--untracked-files=no']).out;
  if (dirty) {
    return `uncommitted changes after the ${role.name} in round ${round}: ${dirty
      .split('\n')
      .map((l) => l.trim())
      .join(', ')}; commit them`;
  }
  if (role.kind === 'code' && deps.git(['rev-parse', 'HEAD']).out === head) {
    return `no new commit from the ${role.name} in round ${round}: implement or fix, then commit`;
  }
  return null;
}

/**
 * The role's result: its ClickUp comment posted during this run; else its comment draft (`.tossana/tmp/<id>-<role>.md`
 * written during the run), posted by the kit; else the report in its final answer, posted by the kit.
 */
async function collectResult(
  ctx: CliContext,
  deps: PipelineDeps,
  post: (text: string) => Promise<void>,
  id: string,
  role: PipelineRole,
  run: AgentRun,
  before: Set<string>,
  startedAt: number,
): Promise<{ comment: AgentComment; source: string } | null> {
  const fresh = (await deps.client.getComments(id))
    .filter((c) => !before.has(String(c.id)))
    .map((c) => parseAgentComment(c.comment_text ?? ''))
    .filter((c): c is AgentComment => c?.agent === role.name);
  if (fresh.length) return { comment: fresh.at(-1)!, source: 'comment' };

  const draft = join(ctx.cwd, ...TMP_DIR.split('/'), `${id}-${role.name}.md`);
  if (existsSync(draft) && statSync(draft).mtimeMs >= startedAt - 2000) {
    const text = readFileSync(draft, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim();
    const comment = parseAgentComment(text);
    if (comment?.agent === role.name) {
      await post(text);
      rmSync(draft, { force: true });
      return { comment, source: 'draft posted by the kit' };
    }
  }

  const report = extractReport(run.text, role.name);
  if (report) {
    await post(report.text);
    return { comment: report.comment, source: 'final answer posted by the kit' };
  }
  return null;
}
