import { describe, expect, it } from 'vitest';
import { DoneGuardError } from '../errors.js';
import {
  assertStatusNameAllowed,
  assertStatusTypeAllowed,
  canAgentSet,
  isClosedType,
  statusNameRefusal,
} from './guard.js';

const ALLOWED = ['to do', 'coding', 'in review', 'testing', 'ready for review'];

describe('layer 1: forbidden words', () => {
  it.each([
    'done',
    'Done',
    'DONE',
    ' done ',
    'done ✅',
    'Complete',
    'completed',
    'COMPLETE',
    'closed',
    'Closed',
    'not done',
    'review done',
    'incomplete',
  ])('refuses "%s"', (status) => {
    expect(statusNameRefusal(status, [...ALLOWED, status])).toMatch(/forbidden word/);
  });

  it('refuses even when someone adds a done status to the allow-list', () => {
    expect(() => assertStatusNameAllowed('Done', [...ALLOWED, 'done'])).toThrow(DoneGuardError);
  });
});

describe('layer 2: allow-list', () => {
  it.each(ALLOWED)('allows "%s"', (status) => {
    expect(statusNameRefusal(status, ALLOWED)).toBeNull();
  });

  it('compares case- and whitespace-insensitively', () => {
    expect(statusNameRefusal('  In Review ', ALLOWED)).toBeNull();
    expect(statusNameRefusal('READY FOR REVIEW', [' Ready For Review '])).toBeNull();
  });

  it('refuses anything not in the list', () => {
    expect(statusNameRefusal('shipped', ALLOWED)).toMatch(/not an agent status/);
    expect(statusNameRefusal('ready for narak', ALLOWED)).toMatch(/not an agent status/);
  });

  it('refuses an empty status', () => {
    expect(statusNameRefusal('   ', ALLOWED)).toBe('the status is empty');
  });
});

describe('assertStatusNameAllowed', () => {
  it('throws DoneGuardError with exit code 2 and a clear message', () => {
    try {
      assertStatusNameAllowed('Done', ALLOWED);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DoneGuardError);
      const err = e as DoneGuardError;
      expect(err.exitCode).toBe(2);
      expect(err.status).toBe('Done');
      expect(err.message).toMatch(/^BLOCKED: agents may not set status "Done"/);
      expect(err.message).toMatch(/Only the human owner marks tasks Done/);
    }
  });

  it('does not throw for an allowed status', () => {
    expect(() => assertStatusNameAllowed('coding', ALLOWED)).not.toThrow();
  });
});

describe('layer 3: ClickUp status type', () => {
  it.each(['done', 'closed', 'Done', 'CLOSED', ' closed '])('treats type "%s" as closed', (type) => {
    expect(isClosedType(type)).toBe(true);
    expect(() => assertStatusTypeAllowed({ status: 'ready for review', type })).toThrow(DoneGuardError);
  });

  it.each(['open', 'custom', undefined, null, ''])('allows type %s', (type) => {
    expect(isClosedType(type)).toBe(false);
    expect(() => assertStatusTypeAllowed({ status: 'coding', type })).not.toThrow();
  });

  it('blocks a harmless-looking name whose type is closed', () => {
    expect(() => assertStatusTypeAllowed({ status: 'shipped', type: 'closed' })).toThrow(/ClickUp type is "closed"/);
  });
});

describe('canAgentSet', () => {
  it('combines all three layers', () => {
    expect(canAgentSet({ status: 'coding', type: 'custom' }, ALLOWED)).toBe(true);
    expect(canAgentSet({ status: 'coding', type: 'closed' }, ALLOWED)).toBe(false);
    expect(canAgentSet({ status: 'complete', type: 'closed' }, [...ALLOWED, 'complete'])).toBe(false);
    expect(canAgentSet({ status: 'backlog', type: 'open' }, ALLOWED)).toBe(false);
  });
});
