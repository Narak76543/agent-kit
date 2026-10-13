import { describe, expect, it } from 'vitest';
import {
  checkRequest,
  newSessionToken,
  secretValues,
  securityHeaders,
  tokenMatches,
  type RequestLike,
} from './security.js';

const PORT = 51234;
const TOKEN = 'a'.repeat(43);

const req = (over: Partial<RequestLike> & { headers?: RequestLike['headers'] } = {}): RequestLike => ({
  method: 'GET',
  url: '/api/project',
  ...over,
  headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...over.headers },
});
const status = (r: RequestLike) => {
  const c = checkRequest(r, PORT, TOKEN);
  return c.ok ? 200 : c.status;
};

describe('session token', () => {
  it('is random, 256 bits, URL-safe', () => {
    const a = newSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(a);
  });

  it('compares exactly', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
  });
});

describe('checkRequest: Host (DNS rebinding)', () => {
  it('accepts 127.0.0.1 and localhost on our port', () => {
    expect(status(req())).toBe(200);
    expect(status(req({ headers: { host: `localhost:${PORT}` } }))).toBe(200);
    expect(status(req({ headers: { host: `LOCALHOST:${PORT}` } }))).toBe(200);
  });

  it.each([
    ['an attacker domain resolving to 127.0.0.1', `evil.example:${PORT}`],
    ['another port', '127.0.0.1:8080'],
    ['no port', '127.0.0.1'],
    ['a LAN address', `192.168.1.5:${PORT}`],
    ['IPv6 loopback (we bind IPv4 only)', `[::1]:${PORT}`],
    ['empty', ''],
  ])('refuses %s', (_why, host) => {
    expect(status(req({ headers: { host } }))).toBe(421);
  });

  it('refuses a missing Host header', () => {
    const r = req();
    delete r.headers.host;
    expect(status(r)).toBe(421);
  });
});

describe('checkRequest: Origin and cross-site requests', () => {
  it('accepts our own origin', () => {
    expect(status(req({ headers: { origin: `http://127.0.0.1:${PORT}` } }))).toBe(200);
    expect(status(req({ headers: { origin: `http://localhost:${PORT}` } }))).toBe(200);
  });

  it.each([
    'http://evil.example',
    `http://evil.example:${PORT}`,
    `https://127.0.0.1:${PORT}`,
    'http://127.0.0.1:3100', // e.g. the Team Dashboard in dev
    'null', // sandboxed iframes, file:// pages
  ])('refuses Origin %s, even with the right token', (origin) => {
    expect(status(req({ headers: { origin } }))).toBe(403);
    expect(status(req({ method: 'POST', headers: { origin, 'content-type': 'application/json' } }))).toBe(403);
  });

  it('requires Origin on POST', () => {
    expect(status(req({ method: 'POST', headers: { 'content-type': 'application/json' } }))).toBe(403);
  });

  it('refuses requests the browser marks as cross-site', () => {
    expect(status(req({ headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(403);
    expect(status(req({ headers: { 'sec-fetch-site': 'same-site' } }))).toBe(403);
    expect(status(req({ headers: { 'sec-fetch-site': 'same-origin' } }))).toBe(200);
  });

  it('only accepts JSON bodies on POST (no form posts from other pages)', () => {
    const post = (type?: string) =>
      req({
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${PORT}`, ...(type ? { 'content-type': type } : {}) },
      });
    expect(status(post('application/json'))).toBe(200);
    expect(status(post('text/plain'))).toBe(415);
    expect(status(post('application/x-www-form-urlencoded'))).toBe(415);
    expect(status(post())).toBe(415);
  });

  it('allows only GET and POST (no CORS preflight answers)', () => {
    for (const method of ['OPTIONS', 'PUT', 'DELETE', 'PATCH']) expect(status(req({ method }))).toBe(405);
  });
});

describe('checkRequest: session token', () => {
  it('API: needs Authorization: Bearer <token>', () => {
    expect(status(req({ headers: { authorization: '' } }))).toBe(401);
    expect(status(req({ headers: { authorization: `Bearer ${TOKEN}x` } }))).toBe(401);
    expect(status(req({ headers: { authorization: TOKEN } }))).toBe(401);
    expect(status(req({ headers: { authorization: `Basic ${TOKEN}` } }))).toBe(401);
  });

  it('API: a token in the URL is not enough', () => {
    expect(status(req({ url: `/api/project?token=${TOKEN}`, headers: { authorization: '' } }))).toBe(401);
  });

  it('page: needs ?token=<token>', () => {
    const page = (url: string) => req({ url, headers: { authorization: '' } });
    expect(status(page(`/?token=${TOKEN}`))).toBe(200);
    expect(status(page('/'))).toBe(401);
    expect(status(page('/?token=wrong'))).toBe(401);
    expect(status(page('/favicon.ico'))).toBe(401);
  });

  it('page: only GET', () => {
    expect(
      status(req({ method: 'POST', url: `/?token=${TOKEN}`, headers: { origin: `http://127.0.0.1:${PORT}` } })),
    ).toBe(405);
  });
});

describe('securityHeaders', () => {
  it('allows only the nonce-tagged inline script and style, no other origin, no framing, no referrer', () => {
    const h = securityHeaders('abc123');
    expect(h['content-security-policy']).toContain("default-src 'none'");
    expect(h['content-security-policy']).toContain("script-src 'nonce-abc123'");
    expect(h['content-security-policy']).toContain("style-src 'nonce-abc123'");
    expect(h['content-security-policy']).toContain("connect-src 'self'");
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['cache-control']).toBe('no-store');
    expect(securityHeaders()['content-security-policy']).toContain("script-src 'none'");
  });
});

describe('secretValues', () => {
  it('collects values of secret-looking keys only', () => {
    const v = secretValues(
      { CLICKUP_API_TOKEN: 'pk_1', FIGMA_API_KEY: 'figd_x', CLICKUP_OWNER_USER_ID: '777', AGENT_CMD: 'node a.js' },
      { GITHUB_PAT: 'ghp_y', OPENAI_API_KEY: 'sk-z', DB_PASSWORD: 'pw', PATH: '/usr/bin', EMPTY_TOKEN: '' },
    );
    expect(v.sort()).toEqual(['figd_x', 'ghp_y', 'pk_1', 'pw', 'sk-z']);
  });
});
