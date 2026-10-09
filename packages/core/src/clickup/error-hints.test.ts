import { describe, expect, it } from 'vitest';
import { ClickUpApiError, KitError } from '../errors.js';
import { clickUpErrorHint, errorCode, tokenFormatProblem } from './error-hints.js';

const apiError = (status: number, body: unknown = {}) => new ClickUpApiError(status, 'GET', '/user', body);

describe('clickUpErrorHint', () => {
  it.each(['OAUTH_019', 'OAUTH_021', 'OAUTH_025', 'OAUTH_077'])('explains a revoked token (%s)', (code) => {
    const hint = clickUpErrorHint(apiError(401, { err: 'Token invalid', ECODE: code }));
    expect(hint).toContain(`${code}: token not found`);
    expect(hint).toContain('Settings → Apps → API Token');
    expect(hint).toContain('CLICKUP_API_TOKEN=pk_');
  });

  it.each(['OAUTH_023', 'OAUTH_026', 'OAUTH_027', 'OAUTH_029', 'OAUTH_037', 'OAUTH_045'])(
    'explains a workspace the token cannot access (%s)',
    (code) => {
      expect(clickUpErrorHint(apiError(401, { ECODE: code }))).toContain('team not authorized');
    },
  );

  it('does not treat codes outside the documented range as team errors', () => {
    expect(clickUpErrorHint(apiError(401, { ECODE: 'OAUTH_046' }))).toContain('HTTP 401, OAUTH_046');
    expect(clickUpErrorHint(apiError(401, { ECODE: 'OAUTH_028' }))).toContain('rejected the token');
  });

  it('explains a missing Authorization header', () => {
    expect(clickUpErrorHint(apiError(400, { ECODE: 'OAUTH_017' }))).toContain('No token was sent');
  });

  it('explains other HTTP errors', () => {
    expect(clickUpErrorHint(apiError(401))).toContain('HTTP 401)');
    expect(clickUpErrorHint(apiError(403))).toContain('no access');
    expect(clickUpErrorHint(apiError(404, { ECODE: 'ITEM_015' }))).toContain('customTaskIds');
    expect(clickUpErrorHint(apiError(429))).toContain('rate limit');
    expect(clickUpErrorHint(apiError(500))).toBeNull();
  });

  it('ignores errors that are not ClickUp API errors', () => {
    expect(clickUpErrorHint(new KitError('x'))).toBeNull();
    expect(errorCode(new Error('x'))).toBeNull();
    expect(errorCode(apiError(401, null))).toBeNull();
    expect(errorCode(apiError(401, { ECODE: 5 }))).toBeNull();
  });
});

describe('tokenFormatProblem', () => {
  it('accepts a normal personal token', () => {
    expect(tokenFormatProblem('pk_123_ABC')).toBeNull();
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['"pk_1_A"', 'quotes'],
    ['pk_1 _A', 'spaces'],
    ['abc123', 'does not start with "pk_"'],
  ])('flags %s', (token, problem) => {
    expect(tokenFormatProblem(token)).toContain(problem);
  });
});
