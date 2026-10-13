/**
 * Local Console request checks (plan §8.3). The console can start processes on this machine, so every request must
 * come from the page we opened, on this machine:
 * - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding: an attacker's domain resolving to 127.0.0.1
 *   still sends its own name as Host).
 * - Origin, when sent, must be ours; POST must send it.
 * - The session token: in the page URL (`?token=`) for the page itself, as `Authorization: Bearer` for the API.
 *   A custom header cannot be sent cross-site without a CORS preflight, which this server never answers.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const newSessionToken = () => randomBytes(32).toString('base64url');
export const newNonce = () => randomBytes(16).toString('base64');

/** Constant-time compare (no early exit that would leak how many characters matched). */
export function tokenMatches(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const allowedHosts = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];
export const allowedOrigins = (port: number) => allowedHosts(port).map((h) => `http://${h}`);

export type CheckResult = { ok: true } | { ok: false; status: number; error: string };

export interface RequestLike {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
}

/** The checks every request passes before any route runs. */
export function checkRequest(req: RequestLike, port: number, token: string): CheckResult {
  const deny = (status: number, error: string): CheckResult => ({ ok: false, status, error });
  const host = (req.headers.host ?? '').toLowerCase();
  if (!allowedHosts(port).includes(host)) return deny(421, 'wrong Host header');

  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') return deny(405, 'method not allowed');
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins(port).includes(origin.toLowerCase()))
    return deny(403, 'cross-site request');
  if (method === 'POST' && origin === undefined) return deny(403, 'missing Origin header');
  // Browsers mark requests from other sites; refuse them even if the Origin check above was somehow passed.
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return deny(403, 'cross-site request');

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    const auth = req.headers.authorization ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    if (!tokenMatches(given, token)) return deny(401, 'missing or wrong session token');
    if (method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json'))
      return deny(415, 'JSON only');
    return { ok: true };
  }
  if (method !== 'GET') return deny(405, 'method not allowed');
  if (!tokenMatches(url.searchParams.get('token'), token)) return deny(401, 'missing or wrong session token');
  return { ok: true };
}

/** Headers for every response. `nonce` allows the page's own inline script and style, nothing else. */
export function securityHeaders(nonce?: string): Record<string, string> {
  const csp = [
    "default-src 'none'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    nonce ? `style-src 'nonce-${nonce}'` : "style-src 'none'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
  };
}

/** Values that must never reach the browser: secret-looking keys from .env and the process environment. */
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|_PAT$|_KEY$/i;

export function secretValues(...sources: Record<string, string | undefined>[]): string[] {
  const out = new Set<string>();
  for (const env of sources)
    for (const [key, value] of Object.entries(env)) if (value && SECRET_KEY.test(key)) out.add(value);
  return [...out];
}
