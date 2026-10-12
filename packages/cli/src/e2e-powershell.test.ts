/**
 * End-to-end on Windows: the BUILT CLI, called from powershell.exe (5.1) like a teammate would,
 * against a local fake ClickUp server, in a folder whose path has spaces.
 * Skipped on other platforms and when the CLI has not been built (`pnpm build`).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const TOKEN = 'pk_12345678_E2ETOKENE2ETOKENE2ETOKEN';
const enabled = process.platform === 'win32' && existsSync(DIST);

interface Received {
  method: string;
  url: string;
  body: unknown;
}

let server: Server;
let baseUrl = '';
let received: Received[] = [];
let userReply: { status: number; body: unknown } = { status: 200, body: { user: { id: 777, username: 'dara' } } };
let root = '';
let dir = '';

const LIST = {
  id: 'L1',
  name: 'Mobile',
  statuses: ['to do', 'coding', 'in review', 'testing', 'ready for review'].map((status) => ({
    status,
    type: 'custom',
  })),
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => resolve(data ? JSON.parse(data) : undefined));
  });
}

/** A PowerShell single-quoted string literal ('' escapes a quote). */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Runs a PowerShell 5.1 command line in the project folder; resolves with output and $LASTEXITCODE. */
function ps(command: string): Promise<{ code: number; out: string; err: string }> {
  const script =
    `$ErrorActionPreference='Continue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ` +
    `$env:TOSSANA_CLICKUP_API_URL=${psq(baseUrl)}; Set-Location -LiteralPath ${psq(dir)}; $cli=${psq(DIST)}; ` +
    `${command}; exit $LASTEXITCODE`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, out: stdout, err: stderr }),
    );
  });
}

const comments = () => received.filter((r) => r.method === 'POST' && r.url.startsWith('/api/v2/task/T1/comment'));

describe.skipIf(!enabled)('PowerShell 5.1 end-to-end (built CLI)', () => {
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      received.push({ method: req.method!, url: req.url!, body });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const url = req.url!.split('?')[0];
      if (url === '/api/v2/user') return send(userReply.status, userReply.body);
      if (url === '/api/v2/list/L1') return send(200, LIST);
      if (url === '/api/v2/task/T1' && req.method === 'GET') {
        return send(200, { id: 'T1', name: 'Login', status: { status: 'to do', type: 'open' }, list: { id: 'L1' } });
      }
      if (url === '/api/v2/task/T1' && req.method === 'PUT') return send(200, {});
      if (url === '/api/v2/task/T1/comment' && req.method === 'POST') return send(200, { id: 1 });
      return send(404, { err: 'not found' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api`;
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    received = [];
    userReply = { status: 200, body: { user: { id: 777, username: 'dara' } } };
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'tak e2e '));
    dir = join(root, "Dara's Project");
    mkdirSync(dir);
    writeFileSync(join(dir, '.env'), `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\n`);
    writeFileSync(
      join(dir, 'agent.config.json'),
      JSON.stringify({
        version: 1,
        project: { name: 'E2E', type: 'react', skill: 'frontend-master' },
        clickup: { listId: 'L1' },
      }),
    );
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const TRICKY = `He said "ship it" & it's 100% $HOME %PATH% \`tick\` ខ្មែរ`;

  it('--file keeps quotes, $, %, backticks and Khmer text exactly (path with spaces and an apostrophe)', async () => {
    mkdirSync(join(dir, '.agents', 'tmp'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'tmp', 'T1-coder.md'), `${TRICKY}\nline 2\n`, 'utf8');
    const r = await ps(`node $cli clickup comment T1 --file '.agents/tmp/T1-coder.md'`);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(comments()[0]!.body).toEqual({ comment_text: `${TRICKY}\nline 2`, notify_all: false });
    expect(existsSync(join(dir, '.agents', 'tmp', 'T1-coder.md'))).toBe(false);
  });

  it('stdin (-) keeps quotes and Khmer text', async () => {
    const r = await ps(`'stdin: He said "ship it" ខ្មែរ' | node $cli clickup comment T1 -`);
    expect(r.code).toBe(0);
    expect((comments()[0]!.body as { comment_text: string }).comment_text).toBe('stdin: He said "ship it" ខ្មែរ');
  });

  it('arguments WITHOUT double quotes arrive intact', async () => {
    const r = await ps(`node $cli clickup comment T1 'Done-ish: 100% & $HOME, it''s fine'`);
    expect(r.code).toBe(0);
    expect((comments()[0]!.body as { comment_text: string }).comment_text).toBe("Done-ish: 100% & $HOME, it's fine");
  });

  it('documents the PowerShell 5.1 problem: double quotes inside an argument are dropped', async () => {
    await ps(`node $cli clickup comment T1 'He said "ship it"'`);
    // This is why agents always use --file. (PowerShell 7.3+ passes them correctly.)
    expect((comments()[0]!.body as { comment_text: string }).comment_text).not.toBe('He said "ship it"');
  });

  it('status done exits with code 2 in $LASTEXITCODE and calls nothing', async () => {
    const r = await ps(`node $cli clickup status T1 done`);
    expect(r.code).toBe(2);
    expect(r.err).toContain('BLOCKED: agents may not set status "done"');
    expect(received).toHaveLength(0);
  });

  it('status human moves the task', async () => {
    const r = await ps(`node $cli clickup status T1 human`);
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK: T1 to do -> ready for review');
    expect(received.find((x) => x.method === 'PUT')!.body).toEqual({ status: 'ready for review' });
  });

  it('doctor shows the fix for a revoked token (OAUTH_025) and exits 1, without the token', async () => {
    userReply = { status: 401, body: { err: 'Token invalid', ECODE: 'OAUTH_025' } };
    const r = await ps(`node $cli doctor`);
    expect(r.code).toBe(1);
    // Emoji in Windows Terminal, [FAIL] in the old console (depends on where the tests run).
    expect(r.out).toMatch(/(\[FAIL\]|❌) ClickUp token works/);
    expect(r.out).toContain('FIX: Your ClickUp token is not valid any more (OAUTH_025: token not found)');
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it('--cwd works with a path that has spaces', async () => {
    const r = await ps(
      `Set-Location -LiteralPath ${psq(root)}; node $cli --cwd "Dara's Project" clickup handoff T1 'note'`,
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, '.agents', 'handoff', 'T1.md'), 'utf8')).toContain('note');
  });

  it('run --dry-run prints the exact command', async () => {
    const r = await ps(`node $cli run --task T1 --dry-run`);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /\$ opencode run --agent orchestrator --dir \S.* "Work on ClickUp task T1\. Follow AGENTS\.md and your agent instructions\."/,
    );
  });
});
