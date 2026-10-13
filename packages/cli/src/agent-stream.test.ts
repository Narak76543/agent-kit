import { describe, expect, it } from 'vitest';
import { formatAgentComment } from '@tossana/agents-core';
import { extractReport, streamRenderer, toolArgs } from './agent-stream.js';

const all = (format: Parameters<typeof streamRenderer>[0], lines: object[]) => {
  const r = streamRenderer(format);
  const out = [...lines.flatMap((l) => r.line(JSON.stringify(l))), ...r.end()];
  return { out, final: r.finalText() };
};

describe('agy stream-json (event shapes from agy 1.3.4)', () => {
  const step = (s: object) => ({ event: 'step_update', step_update: { conversation_id: 'c', ...s } });
  const events = [
    { event: 'init', conversation_id: 'c', init: { cwd: '/p', tools: ['run_command'] } },
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Checking the ' }),
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'branch.' }),
    step({
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'git status' } },
    }),
    step({
      step_index: 2,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', output: 'a\r\nb\r\nc\r\nd\r\ne\r\n' },
    }),
    step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '[AGENT: coder] [RESULT: DONE' }),
    step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '_CODING] [ROUND: 1]\n' }),
    {
      event: 'result',
      result: { status: 'SUCCESS', response: 'final answer\n', duration_seconds: 8.6, num_turns: 1 },
    },
  ];

  it('renders text, tool calls and the first lines of their output', () => {
    expect(all('agy-stream', events).out).toEqual([
      '[agy] session started',
      'Checking the branch.',
      '→ run_command git status',
      '    a',
      '    b',
      '    c',
      '    … (2 more lines)',
      '[AGENT: coder] [RESULT: DONE_CODING] [ROUND: 1]',
      '[agy] finished: SUCCESS, 9 s',
    ]);
  });

  it('the final answer is the result response (else the streamed text)', () => {
    expect(all('agy-stream', events).final).toBe('final answer\n');
    expect(all('agy-stream', events.slice(0, -1)).final).toContain('[AGENT: coder] [RESULT: DONE_CODING]');
  });

  it('prints lines that are not JSON as they are (agy errors, a changed format)', () => {
    const r = streamRenderer('agy-stream');
    expect(r.line('Error: not logged in')).toEqual(['Error: not logged in']);
    expect(r.line('{"event":"something_new"}')).toEqual([]);
    expect(r.line('')).toEqual([]);
  });
});

describe('Claude Code stream-json', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 's', tools: ['Bash'] },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading the task.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git diff main...HEAD' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'diff --git a/x b/x' }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'denied' }] }] },
    },
    { type: 'result', subtype: 'success', is_error: false, duration_ms: 61_000, result: 'the report' },
  ];

  it('renders text, tool calls, results and errors', () => {
    expect(all('claude-stream', events).out).toEqual([
      '[claude] session started',
      'Reading the task.',
      '→ Bash git diff main...HEAD',
      '    diff --git a/x b/x',
      '    (error)',
      '    denied',
      '[claude] finished: success, 61 s',
    ]);
    expect(all('claude-stream', events).final).toBe('the report');
  });
});

describe('text output', () => {
  it('passes lines through; the whole output is the final text', () => {
    const r = streamRenderer('text');
    expect(r.line('step 1')).toEqual(['step 1']);
    r.line('step 2');
    expect(r.finalText()).toBe('step 1\nstep 2\n');
  });
});

describe('toolArgs', () => {
  it('shows the command, file or pattern, else short JSON', () => {
    expect(toolArgs({ AbsolutePath: '/p/a.ts' })).toBe('/p/a.ts');
    expect(toolArgs({ command: 'pnpm lint\n&& pnpm test' })).toBe('pnpm lint && pnpm test');
    expect(toolArgs({ a: 1 })).toBe('{"a":1}');
    expect(toolArgs({ command: 'x'.repeat(300) })).toHaveLength(200);
    expect(toolArgs(null)).toBe('');
  });
});

describe('extractReport', () => {
  const report = formatAgentComment({
    agent: 'reviewer',
    result: 'CHANGES_NEEDED',
    round: 2,
    summary: 'One bug.',
    issues: [{ location: 'a.ts:1', text: 'crash' }],
    next: 'coder',
  });

  it('finds the last report of the role and stops at its Next line', () => {
    const out = `I will check.\n[AGENT: reviewer] [RESULT: APPROVED] [ROUND: 1]\nSummary: old\nNext: tester\n\n\`\`\`\n${report}\n\`\`\`\nThat is all.`;
    const found = extractReport(out, 'reviewer');
    expect(found?.text).toBe(report);
    expect(found?.comment).toMatchObject({ result: 'CHANGES_NEEDED', round: 2, issues: [{ location: 'a.ts:1' }] });
  });

  it('ignores reports of other roles, and text without one', () => {
    expect(extractReport(report, 'tester')).toBeNull();
    expect(extractReport('no report here', 'reviewer')).toBeNull();
    expect(extractReport('[AGENT: reviewer] [RESULT: MAYBE]', 'reviewer')).toBeNull();
  });

  it('accepts a report without a Next line (up to the end, code fences dropped)', () => {
    const found = extractReport(
      '[AGENT: security-reviewer] [RESULT: APPROVED] [ROUND: 1]\nSummary: ok\n```',
      'security-reviewer',
    );
    expect(found?.text).toBe('[AGENT: security-reviewer] [RESULT: APPROVED] [ROUND: 1]\nSummary: ok');
  });
});
