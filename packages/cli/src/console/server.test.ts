/**
 * The Local Console end to end: a real server on 127.0.0.1, a temp git project, the fake ClickUp API and a fake
 * agent (node script). Requests go through node:http so tests can send any Host/Origin, like an attacker could.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED } from '@tossana/agents-core';
import { createContext } from '../context.js';
import { exec, type Exec } from '../exec.js';
import { RUN_LOCK } from '../run-lock.js';
import {
  CONFIG,
  LIST,
  TOKEN,
  fakeApi,
  fakeExec,
  tempProject,
  type FakeApi,
  type TempProject,
} from '../test-utils.test-helper.js';
import { ConsoleApp } from './app.js';
import { startConsoleServer, type ConsoleServer } from './server.js';

const OTHER_SECRET = 'figd_supersecretvalue123';
const HTML = '<!doctype html><script nonce="__CSP_NONCE__">1</script>';

let project: TempProject;
let server: ConsoleServer | undefined;
const children: ChildProcess[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const c of children.splice(0)) c.kill();
  project?.cleanup();
});

const git = (p: TempProject, ...args: string[]) => {
  const r = exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: p.dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * The fake agent: prints secrets (they must arrive redacted), starts a grandchild that would run forever, writes
 * both pids, then runs until killed (or exits at once with QUICK).
 */
const AGENT = `
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
console.log('agent got: ' + process.argv[2]);
console.log('token ${TOKEN} and ${OTHER_SECRET}');
if (process.env.QUICK || fs.existsSync('quick')) process.exit(0);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join('.agents', 'logs', 'pids.json'), JSON.stringify({ agent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`;

function gitProject(options: { tools?: string[] } = {}) {
  const p = tempProject({
    config: { ...CONFIG, tools: options.tools ?? ['opencode'], pipeline: { runner: 'custom' } },
    env:
      `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\nFIGMA_API_KEY=${OTHER_SECRET}\n` +
      `AGENT_CMD=node "fake agent/agent.js" {prompt}\n`,
  });
  p.write('fake agent/agent.js', AGENT);
  p.write('.gitignore', '.env\n.agents/logs/\n.agents/handoff/\nquick\n');
  p.write('.opencode/agents/orchestrator.md', 'x');
  p.write('app.ts', 'v1');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'add', '-A');
  git(p, 'commit', '-q', '-m', 'init');
  return p;
}

const comments = [{ id: '1', date: '1', comment_text: '[AGENT: coder] [RESULT: PASS] [ROUND: 2]\nSummary: built it' }];

function clickUp(status = { status: 'to do', type: 'open' }): FakeApi {
  return (
    fakeApi()
      .on('GET /v2/user', { user: { id: 42, username: 'me' } })
      .on('GET /v2/list/L1/task', {
        tasks: [
          // The token in a task name must never reach the browser.
          { id: 'T2', name: `Leaky ${TOKEN}`, status: { status: 'coding', type: 'custom' } },
          { id: 'T1', name: 'Login screen', status: { status: 'to do', type: 'open' } },
        ],
        last_page: true,
      })
      .on('GET /v2/task/T1', { id: 'T1', name: 'Login screen', status, list: { id: 'L1' } })
      .on('GET /v2/task/T1/comment', { comments })
      .on('POST /v2/task/T1/comment', { id: 9 })
      // The kit's pipeline sets the statuses.
      .on('GET /v2/list/L1', LIST)
      .on('PUT /v2/task/T1', {})
  );
}

async function start(p: TempProject, api = clickUp(), run: Exec = exec) {
  const ctx = createContext({
    cwd: p.dir,
    home: join(dirname(p.dir), 'home'),
    processEnv: {},
    fetch: api.fetch,
    exec: run,
    io: { out: () => {}, err: () => {}, interactive: false },
  });
  server = await startConsoleServer({ app: new ConsoleApp(ctx), html: HTML });
  return server;
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: Record<string, unknown>;
}

/** A raw HTTP request. Defaults are what our own page sends; pass a header as null to leave it out. */
function call(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string | null> } = {},
): Promise<Res> {
  const s = server!;
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const base: Record<string, string | null> = {
    host: `127.0.0.1:${s.port}`,
    authorization: `Bearer ${s.token}`,
    ...(method === 'POST' ? { origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' } : {}),
    ...opts.headers,
  };
  const headers = Object.fromEntries(Object.entries(base).filter(([, v]) => v !== null)) as Record<string, string>;
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: s.port, path, method, headers, setHost: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // HTML or NDJSON
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    r.end();
  });
}

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const runState = async () => ((await call('/api/runs/current')).json.run as { state: string } | null)?.state;

async function previewAndStart(body: Record<string, unknown> = {}) {
  const preview = await call('/api/preview', { body: { taskId: 'T1', mode: 'run', runner: 'custom' } });
  expect(preview.status, preview.text).toBe(200);
  return call('/api/runs', { body: { previewId: preview.json.previewId, ...body } });
}

describe('Local Console server: where it listens', () => {
  it('binds 127.0.0.1 only, on a random port, with a fresh token per start', async () => {
    project = gitProject();
    const a = await start(project);
    const b = await startConsoleServer({ app: new ConsoleApp(createContext({ cwd: project.dir })), html: HTML });
    try {
      expect(a.port).toBeGreaterThan(0);
      expect(b.port).not.toBe(a.port);
      expect(b.token).not.toBe(a.token);
      expect(a.url).toBe(`http://127.0.0.1:${a.port}/?token=${a.token}`);
    } finally {
      await b.close();
    }
  });
});

describe('Local Console server: request checks', () => {
  it('serves the page only with the token, with a fresh CSP nonce and no-referrer', async () => {
    project = gitProject();
    const s = await start(project);
    expect((await call('/', { headers: { authorization: null } })).status).toBe(401);
    expect((await call('/?token=nope', { headers: { authorization: null } })).status).toBe(401);
    const page = await call(`/?token=${s.token}`, { headers: { authorization: null } });
    expect(page.status).toBe(200);
    const nonce = /nonce="([^"]+)"/.exec(page.text)![1]!;
    expect(nonce).not.toBe('__CSP_NONCE__');
    expect(page.headers['content-security-policy']).toContain(`'nonce-${nonce}'`);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    const again = await call(`/?token=${s.token}`, { headers: { authorization: null } });
    expect(/nonce="([^"]+)"/.exec(again.text)![1]).not.toBe(nonce);
  });

  it('refuses API calls without the token, with a wrong token, or with the token only in the URL', async () => {
    project = gitProject();
    const s = await start(project);
    expect((await call('/api/project', { headers: { authorization: null } })).status).toBe(401);
    expect((await call('/api/project', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await call(`/api/project?token=${s.token}`, { headers: { authorization: null } })).status).toBe(401);
    expect((await call('/api/project')).status).toBe(200);
  });

  it('refuses DNS-rebinding Hosts even with the right token', async () => {
    project = gitProject();
    const s = await start(project);
    for (const host of [`attacker.example:${s.port}`, `127.0.0.1:${s.port + 1}`, '127.0.0.1']) {
      const r = await call('/api/project', { headers: { host } });
      expect(r.status, host).toBe(421);
    }
    expect((await call('/api/project', { headers: { host: `localhost:${s.port}` } })).status).toBe(200);
  });

  it('refuses cross-site requests and form posts, and never answers CORS preflights', async () => {
    project = gitProject();
    const s = await start(project);
    const body = { taskId: 'T1', mode: 'run', runner: 'custom' };
    expect((await call('/api/preview', { body, headers: { origin: 'http://attacker.example' } })).status).toBe(403);
    expect((await call('/api/preview', { body, headers: { origin: null } })).status).toBe(403);
    expect((await call('/api/preview', { body, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await call('/api/project', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    const preflight = await call('/api/runs', {
      method: 'OPTIONS',
      headers: { origin: 'http://attacker.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(405);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (await call('/api/preview', { method: 'OPTIONS', headers: { origin: `http://127.0.0.1:${s.port}` } })).status,
    ).toBe(405);
  });

  it('limits request bodies', async () => {
    project = gitProject();
    await start(project);
    const r = await call('/api/preview', { body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
    expect(r.status).toBe(413);
  });
});

describe('Local Console server: no secrets in the browser', () => {
  it('never sends .env values, even when ClickUp data contains the token', async () => {
    project = gitProject();
    await start(project);
    const project_ = await call('/api/project');
    const tasks = await call('/api/tasks');
    expect(tasks.status, tasks.text).toBe(200);
    for (const r of [project_, tasks]) {
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).not.toContain(OTHER_SECRET);
    }
    expect(tasks.text).toContain(`Leaky ${REDACTED}`);
    expect(JSON.stringify(project_.json)).not.toMatch(/CLICKUP_API_TOKEN|FIGMA_API_KEY/);
  });

  it('redacts doctor output', async () => {
    project = gitProject();
    // A ClickUp error that echoes the token back.
    const api = clickUp().on('GET /v2/user', () => new Response(`bad token ${TOKEN}`, { status: 401 }));
    await start(project, api, fakeExec());
    const r = await call('/api/doctor');
    expect(r.status).toBe(200);
    expect((r.json.checks as unknown[]).length).toBeGreaterThan(5);
    expect(r.text).not.toContain(TOKEN);
  });
});

describe('Local Console: my tasks and the preview', () => {
  it('lists my tasks with Run for todo, and only the runners set up in this project', async () => {
    project = gitProject({ tools: ['opencode', 'codex'] }); // codex files missing → not offered
    await start(project);
    const info = (await call('/api/project')).json.project as { runners: string[]; defaultRunner: string };
    expect(info.runners).toEqual(['opencode', 'custom']);
    expect(info.defaultRunner).toBe('custom');
    const { tasks } = (await call('/api/tasks')).json as { tasks: { id: string; action: string | null }[] };
    expect(tasks.map((t) => [t.id, t.action])).toEqual([
      ['T1', 'run'],
      ['T2', null], // in progress but no task branch here
    ]);
  });

  it('refuses a runner that is not set up, and bad task ids', async () => {
    project = gitProject();
    await start(project);
    const codex = await call('/api/preview', { body: { taskId: 'T1', mode: 'run', runner: 'codex' } });
    expect(codex.status).toBe(400);
    const bad = await call('/api/preview', { body: { taskId: 'T1; rm -rf /', mode: 'run', runner: 'custom' } });
    expect(bad.status).toBe(400);
  });

  it('shows the exact dry-run output and changes nothing', async () => {
    project = gitProject();
    const api = clickUp();
    await start(project, api);
    const r = await call('/api/preview', { body: { taskId: 'T1', mode: 'run', runner: 'custom' } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.output).toContain('dry run: nothing is changed');
    expect(r.json.output).toContain('git: create task/T1 from main');
    expect(r.json.output).toContain('$ node "fake agent/agent.js"');
    expect(api.calls).toHaveLength(0);
    expect(git(project, 'branch', '--show-current')).toBe('main');
  });
});

describe('Local Console: starting runs needs a confirmation', () => {
  it('refuses to start without a preview, and a preview works once', async () => {
    project = gitProject();
    project.write('quick', '1');
    await start(project);
    expect((await call('/api/runs', { body: {} })).status).toBe(400);
    expect((await call('/api/runs', { body: { previewId: 'made-up' } })).status).toBe(409);
    const preview = await call('/api/preview', { body: { taskId: 'T1', mode: 'run', runner: 'custom' } });
    const first = await call('/api/runs', { body: { previewId: preview.json.previewId } });
    expect(first.status, first.text).toBe(200);
    await until('the run to end', async () => (await runState()) !== 'running');
    expect((await call('/api/runs', { body: { previewId: preview.json.previewId } })).status).toBe(409);
  });

  it('resume: leftover changes are committed only after confirmWip', async () => {
    project = gitProject();
    project.write('quick', '1');
    git(project, 'switch', '-q', '-c', 'task/T1');
    project.write('app.ts', 'half done');
    await start(project, clickUp({ status: 'coding', type: 'custom' }));

    const preview = await call('/api/preview', { body: { taskId: 'T1', mode: 'resume', runner: 'custom' } });
    expect(preview.status, preview.text).toBe(200);
    expect(preview.json.needsWipCommit).toBe(true);
    expect(preview.json.dirty).toContain('app.ts');

    const refused = await call('/api/runs', { body: { previewId: preview.json.previewId } });
    expect(refused.status).toBe(409);
    expect(refused.json.needsWipCommit).toBe(true);
    expect(git(project, 'log', '-1', '--format=%s')).toBe('init');

    const ok = await call('/api/runs', { body: { previewId: preview.json.previewId, confirmWip: true } });
    expect(ok.status, ok.text).toBe(200);
    await until('the run to end', async () => (await runState()) !== 'running');
    expect(git(project, 'log', '-1', '--format=%s', 'task/T1')).toBe('WIP: handoff from an earlier run');
  });
});

describe('Local Console: live run, one at a time, Stop', () => {
  it('streams the redacted log, refuses a second run, and Stop kills the agent and its child', async () => {
    project = gitProject();
    await start(project);
    const started = await previewAndStart();
    expect(started.status, started.text).toBe(200);
    expect(existsSync(join(project.dir, RUN_LOCK))).toBe(true);

    const pidsFile = join(project.dir, '.agents', 'logs', 'pids.json');
    const pids = await until('the agent to start', () =>
      existsSync(pidsFile) ? (JSON.parse(readFileSync(pidsFile, 'utf8')) as { agent: number; child: number }) : null,
    );
    expect(alive(pids.agent) && alive(pids.child)).toBe(true);

    // One run per project.
    const second = await previewAndStart();
    expect(second.status).toBe(409);
    expect(second.json.error).toContain('already going');

    // Status: role and round from ClickUp + the handoff file.
    const status = await call('/api/runs/current/status');
    expect(status.json).toMatchObject({ role: 'todo', round: 2, lastAgent: 'coder', lastResult: 'PASS' });
    // The newest handoff entry: the kit's STARTED comment.
    expect(status.json.handoff).toBe('ClickUp comment');

    expect((await call('/api/runs/stop', { body: {} })).status).toBe(200);
    await until('the run to stop', async () => (await runState()) === 'stopped');
    await until('the agent and its child to be gone', () => !alive(pids.agent) && !alive(pids.child));
    expect(existsSync(join(project.dir, RUN_LOCK))).toBe(false);

    const stream = await call('/api/runs/current/stream?from=0');
    const events = stream.text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; text?: string; state?: string });
    const log = events.map((e) => e.text ?? '').join('\n');
    expect(log).toContain('agent got: You are the coder for ClickUp task T1, round 1.');
    expect(log).toContain(`token ${REDACTED} and ${REDACTED}`);
    expect(stream.text).not.toContain(TOKEN);
    expect(stream.text).not.toContain(OTHER_SECRET);
    expect(events.at(-1)).toEqual({ type: 'state', state: 'stopped' });
    expect((await call('/api/runs/stop', { body: {} })).status).toBe(409);
  }, 30_000);

  it('a run started elsewhere (CLI, another console) blocks a new one', async () => {
    project = gitProject();
    await start(project);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(other);
    project.write(RUN_LOCK, JSON.stringify({ pid: other.pid, task: 'T9' }));
    const preview = await call('/api/preview', { body: { taskId: 'T1', mode: 'run', runner: 'custom' } });
    expect(preview.json.busy).toContain('task T9');
    const r = await call('/api/runs', { body: { previewId: preview.json.previewId } });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('Another run is going');
  });

  it('closing the console stops a running agent', async () => {
    project = gitProject();
    const s = await start(project);
    await previewAndStart();
    const pidsFile = join(project.dir, '.agents', 'logs', 'pids.json');
    const pids = await until('the agent to start', () =>
      existsSync(pidsFile) ? (JSON.parse(readFileSync(pidsFile, 'utf8')) as { agent: number; child: number }) : null,
    );
    await s.close();
    server = undefined;
    await until('the agent and its child to be gone', () => !alive(pids.agent) && !alive(pids.child));
  }, 30_000);
});

describe('run lock file', () => {
  it('a stale lock (process gone) is taken over', async () => {
    project = gitProject();
    project.write('quick', '1');
    project.write(RUN_LOCK, JSON.stringify({ pid: 2 ** 30, task: 'T0' }));
    await start(project);
    const r = await previewAndStart();
    expect(r.status, r.text).toBe(200);
    await until('the run to end', async () => (await runState()) !== 'running');
    expect(await runState()).toBe('done');
  });
});
