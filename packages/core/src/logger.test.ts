import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, redact } from './logger.js';

const TOKEN = 'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

describe('redact', () => {
  it('hides anything that looks like a ClickUp personal token', () => {
    expect(redact(`Authorization: ${TOKEN}`)).toBe(`Authorization: ${REDACTED}`);
    expect(redact(`a ${TOKEN} b ${TOKEN}`)).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it('hides registered secrets that do not look like pk_ tokens', () => {
    expect(redact('token=oauth-secret-value-123', ['oauth-secret-value-123'])).toBe(`token=${REDACTED}`);
  });

  it('ignores very short secrets so normal words are not blanked out', () => {
    expect(redact('the abc test', ['abc'])).toBe('the abc test');
  });

  it('leaves normal text alone', () => {
    expect(redact('task 86abc123 moved to coding')).toBe('task 86abc123 moved to coding');
  });
});

describe('createLogger', () => {
  it('redacts every output channel', () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = createLogger({ stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    log.addSecret('my-oauth-token-value');
    log.info(`info ${TOKEN}`);
    log.warn('warn my-oauth-token-value');
    log.error(`error ${TOKEN}`);
    expect(out).toEqual([`info ${REDACTED}`]);
    expect(err).toEqual([`warn ${REDACTED}`, `error ${REDACTED}`]);
    expect(log.redact(`x ${TOKEN}`)).toBe(`x ${REDACTED}`);
  });
});
