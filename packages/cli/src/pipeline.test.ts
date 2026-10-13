/** The kit's pipeline loop (pipeline.ts) with an in-memory ClickUp, a fake git and scripted agents. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatAgentComment,
  parseAgentComment,
  parseConfig,
  type AgentConfig,
  type ClickUpComment,
  type PipelineRole,
} from '@tossana/agents-core';
import { pipelineLog, PIPELINE_LOG } from './agent-logs.js';
import type { AgentRun } from './agent-process.js';
import { createContext } from './context.js';
import {
  briefPath,
  briefText,
  freshStart,
  resumePoint,
  runPipeline,
  type PipelineClient,
  type StartPoint,
} from './pipeline.js';
import { CONFIG } from './test-utils.test-helper.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tak pipeline '));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (extra: object = {}): AgentConfig => parseConfig({ ...CONFIG, ...extra });

const report = (agent: string, result: string, round: number, issues: string[] = []) =>
  formatAgentComment({ agent, result: result as never, round, summary: `${agent} ${result}`, issues, next: 'x' });

const comment = (id: number, text: string): ClickUpComment => ({
  id: String(id),
  date: String(id),
  comment_text: text,
});

/** In-memory ClickUp: comments oldest first, the status history and the owner notifications. */
function board(initial: string[] = []) {
  const comments: ClickUpComment[] = initial.map((t, i) => comment(i + 1, t));
  const statuses: string[] = [];
  const notified: string[] = [];
  const client: PipelineClient = {
    getComments: async () => [...comments],
    postComment: async (_id, text) => {
      comments.push(comment(comments.length + 1, text));
      return { id: String(comments.length) };
    },
    notify: async (_id, text) => {
      notified.push(text);
      comments.push(comment(comments.length + 1, text));
      return { id: String(comments.length) };
    },
    setStatus: async (taskId, status) => {
      statuses.push(status);
      return { taskId, from: null, to: status };
    },
  };
  const results = () =>
    comments
      .map((c) => parseAgentComment(c.comment_text ?? ''))
      .map((c) => (c ? `${c.agent} ${c.result} r${c.round}` : '-'));
  return { client, comments, statuses, notified, results };
}

/**
 * What each agent does, per "<round>-<role>" (missing = no result): how it reports, and whether it commits or
 * leaves changes. `comment` posts like `cu comment` does.
 */
type Act = {
  result?: string;
  via?: 'comment' | 'draft' | 'final';
  commit?: boolean;
  dirty?: boolean;
  issues?: string[];
  stop?: boolean;
};

function setup(script: Record<string, Act>, options: { config?: AgentConfig; initial?: string[] } = {}) {
  const cfg = options.config ?? config();
  const b = board(options.initial);
  let head = 1;
  let dirty = '';
  const prompts: string[] = [];
  const briefs: Record<string, string> = {};
  let out = '';
  const ctx = createContext({
    cwd: dir,
    io: { out: (t) => (out += t), err: (t) => (out += t) },
    now: () => new Date('2026-10-13T10:00:00Z'),
  });
  const runs: string[] = [];
  const deps = {
    client: b.client,
    format: 'text' as const,
    log: pipelineLog(dir, 'T1', ctx.now, (s: string) => s),
    git: (args: string[]) => {
      if (args[0] === 'rev-parse') return { ok: true, out: String(head), err: '' };
      if (args[0] === 'status') return { ok: true, out: dirty, err: '' };
      return { ok: true, out: '', err: '' };
    },
    runRole: async (role: PipelineRole, prompt: string): Promise<AgentRun> => {
      const round = Number(/round (\d+)/.exec(prompt)![1]);
      const key = `${round}-${role.name}`;
      runs.push(key);
      prompts.push(prompt);
      const brief = join(dir, ...briefPath('T1', round, role.name).split('/'));
      briefs[key] = readFileSync(brief, 'utf8');
      const act = script[key];
      if (act?.stop) return { code: null, stopped: 'interrupted', text: '' };
      if (act?.commit) head++;
      dirty = act?.dirty ? ' M src/app.ts' : '';
      const text = act?.result ? report(role.name, act.result, round, act.issues) : '';
      if (act?.result && act.via === 'comment') await b.client.postComment('T1', text);
      if (act?.result && act.via === 'draft') {
        mkdirSync(join(dir, '.tossana', 'tmp'), { recursive: true });
        writeFileSync(join(dir, '.tossana', 'tmp', `T1-${role.name}.md`), text);
      }
      return { code: 0, stopped: null, text: act?.via === 'final' ? `thinking…\n${text}\n\nDone.` : 'no report' };
    },
  };
  const run = (start: StartPoint = freshStart(cfg), postStart = true) =>
    runPipeline(
      ctx,
      cfg,
      { taskId: 'T1', taskName: 'Login', start, postStart, by: 'Custom command', ownerUserId: '777' },
      deps,
    );
  const pipelineText = () => readFileSync(join(dir, '.agents', 'logs', 'T1', PIPELINE_LOG), 'utf8');
  /** Every FINISHED line (follow stops at the first one, so there must be exactly one per run). */
  const finishedLines = () =>
    pipelineText()
      .split('\n')
      .filter((l) => l.includes('=== FINISHED'));
  return { run, b, runs, prompts, briefs, pipelineText, finishedLines, output: () => out };
}

describe('the pipeline loop', () => {
  it('runs coder → reviewer → tester in order, sets every status, and ends ready for review', async () => {
    const t = setup({
      '1-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
      '1-reviewer': { result: 'APPROVED', via: 'final' },
      '1-tester': { result: 'PASS', via: 'comment', commit: true },
    });
    const result = await t.run();
    expect(result).toMatchObject({ result: 'PASS', round: 1 });
    expect(t.runs).toEqual(['1-coder', '1-reviewer', '1-tester']);
    expect(t.b.statuses).toEqual(['coding', 'in review', 'testing', 'Ready for Review']);
    // STARTED, the coder's draft and the reviewer's final answer posted by the kit, the tester's own comment, PASS.
    expect(t.b.results()).toEqual([
      'orchestrator STARTED r1',
      'coder DONE_CODING r1',
      'reviewer APPROVED r1',
      'tester PASS r1',
      'orchestrator PASS r1',
    ]);
    expect(t.b.notified[0]).toContain('[BY: Custom command]');
    expect(t.b.comments[1]!.comment_text).toContain('[BY: Custom command]');
    expect(existsSync(join(dir, '.tossana', 'tmp', 'T1-coder.md'))).toBe(false);
    expect(t.prompts[0]).toBe(
      'You are the coder for ClickUp task T1, round 1. Read your brief first: .tossana/tmp/T1-r1-coder-brief.md. ' +
        'Then follow AGENTS.md and your agent instructions.',
    );
    const log = t.pipelineText();
    expect(log).toContain('round 1: coder DONE_CODING (draft posted by the kit, exit 0)');
    expect(log).toContain('round 1: reviewer APPROVED (final answer posted by the kit, exit 0)');
    expect(log).toContain('round 1: tester PASS (comment, exit 0)');
    expect(log.trim().split('\n').at(-1)).toMatch(/=== FINISHED PASS \(round 1\)/);
    expect(t.finishedLines()).toHaveLength(1);
    expect(readFileSync(join(dir, '.agents', 'handoff', 'T1.md'), 'utf8')).toContain(
      'Run finished: PASS, rounds used 1.',
    );
  });

  it('sends CHANGES_NEEDED back to the coder with the issues in the next round', async () => {
    const t = setup({
      '1-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
      '1-reviewer': { result: 'CHANGES_NEEDED', via: 'final', issues: ['src/a.ts:3 - null crash'] },
      '2-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
      '2-reviewer': { result: 'APPROVED', via: 'final' },
      '2-tester': { result: 'PASS', via: 'draft' },
    });
    expect(await t.run()).toMatchObject({ result: 'PASS', round: 2 });
    expect(t.runs).toEqual(['1-coder', '1-reviewer', '2-coder', '2-reviewer', '2-tester']);
    expect(t.briefs['2-coder']).toContain('## Fix these issues (from the reviewer)');
    expect(t.briefs['2-coder']).toContain('- src/a.ts:3 - null crash');
    expect(t.briefs['2-reviewer']).toContain('check they are fixed');
    expect(t.b.statuses).toEqual(['coding', 'in review', 'coding', 'in review', 'testing', 'Ready for Review']);
  });

  it('no new commit from the coder is a failed round', async () => {
    const t = setup({
      '1-coder': { result: 'DONE_CODING', via: 'draft' },
      '2-coder': { result: 'DONE_CODING', via: 'draft', dirty: true, commit: true },
      '3-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
      '3-reviewer': { result: 'APPROVED', via: 'final' },
      '3-tester': { result: 'PASS', via: 'draft' },
    });
    expect(await t.run()).toMatchObject({ result: 'PASS', round: 3 });
    expect(t.runs).toEqual(['1-coder', '2-coder', '3-coder', '3-reviewer', '3-tester']);
    expect(t.briefs['2-coder']).toContain('no new commit from the coder in round 1');
    expect(t.briefs['3-coder']).toContain('uncommitted changes after the coder in round 2: M src/app.ts');
  });

  it('a role without a result twice in a row stops with NEEDS_HUMAN, without using the other rounds', async () => {
    const t = setup({
      '1-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
      '2-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
    });
    const result = await t.run();
    expect(result).toMatchObject({ result: 'NEEDS_HUMAN', round: 2 });
    expect(t.runs).toEqual(['1-coder', '1-reviewer', '2-coder', '2-reviewer']);
    expect(t.briefs['2-coder']).toContain('the reviewer gave no result in round 1');
    expect(t.b.notified[0]).toContain('The reviewer gave no result 2 times in a row');
    // Blocked: the status stays where it was.
    expect(t.b.statuses.at(-1)).toBe('in review');
    expect(t.pipelineText()).toContain('round 1: reviewer gave no result');
    expect(t.finishedLines()).toEqual([expect.stringMatching(/=== FINISHED NEEDS_HUMAN \(round 2\)/)]);
  });

  it('a result between two missing ones resets the count', async () => {
    const t = setup(
      {
        '1-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
        '2-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
        '2-reviewer': { result: 'CHANGES_NEEDED', via: 'final', issues: ['x'] },
        '3-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
      },
      { config: config({ pipeline: { maxRounds: 3 } }) },
    );
    expect(await t.run()).toMatchObject({ result: 'NEEDS_HUMAN', round: 3 });
    expect(t.runs).toEqual(['1-coder', '1-reviewer', '2-coder', '2-reviewer', '3-coder', '3-reviewer']);
    // Not "twice in a row": the rounds ran out instead.
    expect(t.b.notified[0]).toContain('3 rounds without passing every check');
  });

  it('out of rounds: NEEDS_HUMAN with the last issues, status ready for review', async () => {
    const t = setup(
      {
        '1-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
        '1-reviewer': { result: 'APPROVED', via: 'final' },
        '1-tester': { result: 'FAIL', via: 'draft', issues: ['a.test.ts:1 - AC-2 fails'] },
        '2-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
        '2-reviewer': { result: 'APPROVED', via: 'final' },
        '2-tester': { result: 'FAIL', via: 'draft', issues: ['a.test.ts:1 - AC-2 still fails'] },
      },
      { config: config({ pipeline: { maxRounds: 2 } }) },
    );
    expect(await t.run()).toMatchObject({ result: 'NEEDS_HUMAN', round: 2 });
    expect(t.b.statuses.at(-1)).toBe('Ready for Review');
    expect(t.b.notified[0]).toContain('2 rounds without passing every check');
    expect(t.b.notified[0]).toContain('- a.test.ts:1 - AC-2 still fails');
    expect(t.finishedLines()).toEqual([expect.stringMatching(/=== FINISHED NEEDS_HUMAN \(round 2\)/)]);
  });

  it('a role reporting NEEDS_HUMAN stops at once; the status stays', async () => {
    const t = setup({ '1-coder': { result: 'NEEDS_HUMAN', via: 'final', issues: ['the API is not specified'] } });
    expect(await t.run()).toMatchObject({ result: 'NEEDS_HUMAN', round: 1 });
    expect(t.runs).toEqual(['1-coder']);
    expect(t.b.statuses).toEqual(['coding']);
  });

  it('Ctrl+C / Stop: returns INTERRUPTED, posts nothing more, and marks the log finished', async () => {
    const t = setup({ '1-coder': { result: 'DONE_CODING', via: 'draft', commit: true }, '1-reviewer': { stop: true } });
    expect(await t.run()).toMatchObject({ result: 'INTERRUPTED', round: 1 });
    expect(t.b.notified).toEqual([]);
    expect(t.pipelineText().trim().split('\n').at(-1)).toMatch(/=== FINISHED STOPPED$/);
  });

  it('a resume continues at the given role without posting STARTED, with the issues it was given', async () => {
    const t = setup({
      '2-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
      '2-reviewer': { result: 'APPROVED', via: 'final' },
      '2-tester': { result: 'PASS', via: 'draft' },
    });
    const start = {
      round: 2,
      index: 0,
      planning: false,
      issues: [{ location: null, text: 'fix x' }],
      issuesFrom: 'tester',
    };
    expect(await t.run(start, false)).toMatchObject({ result: 'PASS', round: 2 });
    expect(t.b.results()[0]).toBe('coder DONE_CODING r2');
    expect(t.briefs['2-coder']).toContain('## Fix these issues (from the tester)\n\n- fix x');
  });

  it('owner feedback is the top-priority instruction of the new round, for every role of that round', async () => {
    const t = setup({
      '3-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
      '3-reviewer': { result: 'APPROVED', via: 'final' },
      '3-tester': { result: 'PASS', via: 'draft' },
    });
    const start = {
      round: 3,
      index: 0,
      planning: false,
      issues: [],
      issuesFrom: null,
      feedback: 'Use the blue button',
    };
    expect(await t.run(start, false)).toMatchObject({ result: 'PASS', round: 3 });
    for (const key of ['3-coder', '3-reviewer', '3-tester']) {
      expect(t.briefs[key]).toContain('## Owner feedback (top priority)\n\nUse the blue button');
    }
  });

  it('custom roles: planners run once before round 1 and their plan goes into every later brief', async () => {
    const cfg = config({
      advanced: { customRoles: true },
      roles: [
        { name: 'manager', preset: 'read-only' },
        { name: 'coder', preset: 'edit-code' },
        { name: 'security-reviewer', preset: 'read-only' },
      ],
    });
    const t = setup(
      {
        '1-manager': { result: 'PLANNED', via: 'final', issues: ['step 1: add the form'] },
        '1-coder': { result: 'DONE_CODING', via: 'draft', commit: true },
        '1-security-reviewer': { result: 'APPROVED', via: 'final' },
      },
      { config: cfg },
    );
    expect(await t.run()).toMatchObject({ result: 'PASS', round: 1 });
    expect(t.runs).toEqual(['1-manager', '1-coder', '1-security-reviewer']);
    expect(t.briefs['1-coder']).toContain('## Plan\n\nFrom the manager: manager PLANNED\n- step 1: add the form');
  });
});

describe('resumePoint', () => {
  const cfg = config();
  const at = (texts: string[], feedback?: string) =>
    resumePoint(
      cfg,
      texts.map((t, i) => comment(i + 1, t)),
      feedback,
    );

  it('nothing reported yet: round 1 at the coder', () => {
    expect(at([report('orchestrator', 'STARTED', 1)])).toMatchObject({ round: 1, index: 0, issues: [] });
  });

  it('after a finished role: the next role of the same round (an interrupted role runs again)', () => {
    expect(at([report('coder', 'DONE_CODING', 2)])).toMatchObject({ round: 2, index: 1 });
    expect(at([report('coder', 'DONE_CODING', 2), report('reviewer', 'APPROVED', 2)])).toMatchObject({
      round: 2,
      index: 2,
    });
    // The tester passed but the run stopped before the end: nothing left to run in that round.
    expect(at([report('tester', 'PASS', 1)])).toMatchObject({ round: 1, index: 3 });
  });

  it('after CHANGES_NEEDED / FAIL / NEEDS_HUMAN: the next round at the coder with those issues', () => {
    expect(at([report('reviewer', 'CHANGES_NEEDED', 1, ['a.ts:1 - bug'])])).toMatchObject({
      round: 2,
      index: 0,
      issues: [{ location: 'a.ts:1', text: 'bug' }],
      issuesFrom: 'reviewer',
    });
    expect(at([report('tester', 'FAIL', 3)])).toMatchObject({
      round: 4,
      issues: [{ location: null, text: 'tester FAIL' }],
    });
  });

  it('feedback: a new round after the highest one, at the coder', () => {
    expect(at([report('orchestrator', 'PASS', 2), 'Please change the color'], 'Please change the color')).toEqual({
      round: 3,
      index: 0,
      planning: false,
      issues: [],
      issuesFrom: null,
      feedback: 'Please change the color',
    });
  });
});

describe('briefText', () => {
  it('names the task, round, branch, context files and the exact report line', () => {
    const cfg = config();
    const role = { name: 'tester', preset: 'edit-tests-only', kind: 'check' } as PipelineRole;
    const text = briefText(cfg, {
      taskId: 'T1',
      taskName: 'Login',
      role,
      round: 2,
      lastRound: 5,
      issues: [],
      issuesFrom: null,
      plans: [],
    });
    expect(text).toContain('# Brief: tester, task T1, round 2');
    expect(text).toContain('- Task: T1 — Login');
    expect(text).toContain('`task/T1`');
    expect(text).toContain('`.agents/context/T1/INDEX.md`');
    expect(text).toContain('[AGENT: tester] [RESULT: PASS | FAIL] [ROUND: 2]');
    expect(text).toContain('never set one yourself');
  });
});
