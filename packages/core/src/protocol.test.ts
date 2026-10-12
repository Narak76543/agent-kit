import { describe, expect, it } from 'vitest';
import { formatAgentComment, parseAgentComment } from './protocol.js';

describe('formatAgentComment', () => {
  it('writes the protocol format with bullet issues', () => {
    const text = formatAgentComment({
      agent: 'reviewer',
      result: 'CHANGES_NEEDED',
      round: 2,
      summary: 'Cart screen has no empty state.',
      issues: [
        { location: 'src/features/cart/CartScreen.tsx:42', text: 'no empty state (AC-21)' },
        'missing i18n keys',
      ],
      next: 'coder',
    });
    expect(text).toBe(
      [
        '[AGENT: reviewer] [RESULT: CHANGES_NEEDED] [ROUND: 2]',
        'Summary: Cart screen has no empty state.',
        'Issues:',
        '- src/features/cart/CartScreen.tsx:42 - no empty state (AC-21)',
        '- missing i18n keys',
        'Next: coder',
      ].join('\n'),
    );
  });

  it('writes "- none" when there are no issues', () => {
    expect(
      formatAgentComment({ agent: 'tester', result: 'PASS', round: 1, summary: ' ok ', next: 'orchestrator' }),
    ).toBe('[AGENT: tester] [RESULT: PASS] [ROUND: 1]\nSummary: ok\nIssues:\n- none\nNext: orchestrator');
  });

  it('flattens multi-line issue text to one line', () => {
    const text = formatAgentComment({
      agent: 'tester',
      result: 'FAIL',
      round: 1,
      summary: 's',
      issues: [{ location: 'a.ts:1', text: 'line one\r\n  line two' }],
      next: 'coder',
    });
    expect(text).toContain('- a.ts:1 - line one line two');
  });

  it('round-trips through the parser', () => {
    const input = {
      agent: 'coder' as const,
      result: 'DONE_CODING' as const,
      round: 3,
      summary: 'Added login form.',
      issues: [{ location: 'src/login.tsx:10', text: 'TODO left for copy text' }],
      next: 'reviewer',
    };
    expect(parseAgentComment(formatAgentComment(input))).toEqual(input);
  });
});

describe('parseAgentComment', () => {
  it('parses the bullet format', () => {
    const c = parseAgentComment(
      [
        '[AGENT: tester] [RESULT: FAIL] [ROUND: 2]',
        'Summary: 2 tests fail in cart.',
        'Issues:',
        '- src/cart.test.ts:14 - expected 3 items, got 2',
        '- src/cart.test.ts:30 - snapshot mismatch',
        'Next: coder',
      ].join('\n'),
    );
    expect(c).toEqual({
      agent: 'tester',
      result: 'FAIL',
      round: 2,
      summary: '2 tests fail in cart.',
      issues: [
        { location: 'src/cart.test.ts:14', text: 'expected 3 items, got 2' },
        { location: 'src/cart.test.ts:30', text: 'snapshot mismatch' },
      ],
      next: 'coder',
    });
  });

  it('parses the one-line EKMONG_MOBILE format (issues separated by ";")', () => {
    const c = parseAgentComment(
      [
        '[AGENT: reviewer] [RESULT: CHANGES_NEEDED] [ROUND: 2]',
        'Summary: Cart screen implements FR-12 but has no empty state and hard-codes a color.',
        "Issues: src/features/cart/CartScreen.tsx:42 - no empty state (AC-21); src/features/cart/CartScreen.tsx:88 - '#fff' instead of colors.surface",
        'Next: coder',
      ].join('\n'),
    );
    expect(c?.issues).toEqual([
      { location: 'src/features/cart/CartScreen.tsx:42', text: 'no empty state (AC-21)' },
      { location: 'src/features/cart/CartScreen.tsx:88', text: "'#fff' instead of colors.surface" },
    ]);
    expect(c?.next).toBe('coder');
  });

  it('treats "none" as no issues, in both formats', () => {
    const head = '[AGENT: reviewer] [RESULT: APPROVED] [ROUND: 1]\nSummary: ok\n';
    expect(parseAgentComment(`${head}Issues: none\nNext: tester`)?.issues).toEqual([]);
    expect(parseAgentComment(`${head}Issues:\n- none\nNext: tester`)?.issues).toEqual([]);
    expect(parseAgentComment(`${head}Issues: N/A\nNext: tester`)?.issues).toEqual([]);
  });

  it('tolerates Windows line endings, odd case and extra whitespace', () => {
    const c = parseAgentComment(
      '  [agent:Coder]   [Result: done_coding]  [ round : 4 ]  \r\n\r\nsummary:   Did the thing.  \r\n  ISSUES:\r\n  *  a.ts:1 - x  \r\nNEXT:  Reviewer \r\n',
    );
    expect(c).toEqual({
      agent: 'coder',
      result: 'DONE_CODING',
      round: 4,
      summary: 'Did the thing.',
      issues: [{ location: 'a.ts:1', text: 'x' }],
      next: 'reviewer',
    });
  });

  it('keeps multi-line summaries and finds the header after other text', () => {
    const c = parseAgentComment(
      'Posting update:\n[AGENT: orchestrator] [RESULT: NEEDS_HUMAN] [ROUND: 5]\nSummary: Ran out of rounds.\nTests still fail on CI.\nNext: human',
    );
    expect(c?.agent).toBe('orchestrator');
    expect(c?.result).toBe('NEEDS_HUMAN');
    expect(c?.summary).toBe('Ran out of rounds.\nTests still fail on CI.');
    expect(c?.issues).toEqual([]);
    expect(c?.next).toBe('human');
  });

  it('accepts a missing round, missing fields and issues without a location', () => {
    expect(parseAgentComment('[AGENT: orchestrator] [RESULT: STARTED]')).toEqual({
      agent: 'orchestrator',
      result: 'STARTED',
      round: null,
      summary: '',
      issues: [],
      next: null,
    });
    expect(parseAgentComment('[AGENT: tester] [RESULT: FAIL] [ROUND: 1]\nIssues:\n- lint fails')?.issues).toEqual([
      { location: null, text: 'lint fails' },
    ]);
  });

  it('ignores stray text before the first field', () => {
    const c = parseAgentComment('[AGENT: coder] [RESULT: DONE_CODING] [ROUND: 1]\nsome chatter\nSummary: done');
    expect(c?.summary).toBe('done');
  });

  it('accepts custom role names (kebab-case) and the PLANNED result', () => {
    expect(
      parseAgentComment('[AGENT: Security-Reviewer] [RESULT: CHANGES_NEEDED] [ROUND: 2]\nNext: coder'),
    ).toMatchObject({
      agent: 'security-reviewer',
      result: 'CHANGES_NEEDED',
      round: 2,
      next: 'coder',
    });
    expect(parseAgentComment('[AGENT: manager] [RESULT: PLANNED] [ROUND: 1]')).toMatchObject({
      agent: 'manager',
      result: 'PLANNED',
    });
  });

  it('returns null for malformed comments', () => {
    expect(parseAgentComment('')).toBeNull();
    expect(parseAgentComment('Looks good to me!')).toBeNull();
    expect(parseAgentComment('[AGENT: bad--name] [RESULT: PASS] [ROUND: 1]')).toBeNull();
    expect(parseAgentComment('[AGENT: -lead] [RESULT: PASS] [ROUND: 1]')).toBeNull();
    expect(parseAgentComment('[AGENT: tester] [RESULT: MAYBE] [ROUND: 1]')).toBeNull();
    expect(parseAgentComment('[RESULT: PASS] [AGENT: tester]')).toBeNull();
    expect(parseAgentComment('[AGENT: tester] PASS')).toBeNull();
    expect(parseAgentComment(undefined as unknown as string)).toBeNull();
  });
});
