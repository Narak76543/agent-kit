/** Local Console: the Agents tab API and runs with an agent profile. */
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from '../context.js';
import { exec, type Exec } from '../exec.js';
import { CONFIG, TOKEN, fakeApi, fakeExec, tempProject, type TempProject } from '../test-utils.test-helper.js';
import { ConsoleApp } from './app.js';
import { startConsoleServer, type ConsoleServer } from './server.js';

let project: TempProject;
let server: ConsoleServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  project?.cleanup();
});

const home = () => join(dirname(project.dir), 'home');
const git = (...args: string[]) => {
  const r = exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: project.dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A git project with opencode + codex set up, a project skill and a user skill. Returns the exec to use. */
function setup(options: { codexInstalled?: boolean } = {}): Exec {
  project = tempProject({
    config: { ...CONFIG, tools: ['opencode', 'codex'], pipeline: { runner: 'opencode' } },
    env: `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\nAGENT_CMD=node "fake agent/agent.js" {prompt}\n`,
  });
  project.write('fake agent/agent.js', `console.log('agent got: ' + process.argv[2]);`);
  project.write('.gitignore', '.env\n.agents/logs/\n.agents/handoff/\n.tossana/tmp/\n');
  project.write('.opencode/agents/orchestrator.md', 'x');
  project.write('.codex/orchestrator.md', 'x');
  project.write('.agents/skills/payments/SKILL.md', '---\ndescription: Stripe rules\n---\n# Payments\n');
  project.write('../home/.agents/skills/my-style/SKILL.md', '# My style\nShort functions.\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // Tool version checks are faked (opencode installed, codex as asked); git and the agent run for real.
  const fake = fakeExec(
    options.codexInstalled ? { 'codex --version': { code: 0, stdout: 'codex-cli 0.130.0\n' } } : {},
  );
  return (cmd, args, o) => (cmd === 'git' || cmd === 'taskkill' ? exec(cmd, args, o) : fake(cmd, args, o));
}

async function start(run: Exec) {
  const api = fakeApi()
    .on('GET /v2/task/T1', { id: 'T1', name: 'Login', status: { status: 'to do', type: 'open' }, list: { id: 'L1' } })
    .on('GET /v2/task/T1/comment', { comments: [] });
  const ctx = createContext({
    cwd: project.dir,
    home: home(),
    processEnv: {},
    fetch: api.fetch,
    exec: run,
    io: { out: () => {}, err: () => {}, interactive: false },
  });
  server = await startConsoleServer({ app: new ConsoleApp(ctx), html: '<p>x</p>' });
}

function call(path: string, body?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const s = server!;
  const headers: Record<string, string> = { host: `127.0.0.1:${s.port}`, authorization: `Bearer ${s.token}` };
  if (body !== undefined) {
    Object.assign(headers, { origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' });
  }
  return new Promise((resolve, reject) => {
    const r = request(
      { host: '127.0.0.1', port: s.port, path, method: body === undefined ? 'GET' : 'POST', headers, setHost: false },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

const rei = { name: 'Rei – Mobile', tool: 'codex', skills: ['payments', 'my-style'], mcp: [], color: 'blue' };

describe('Local Console: Agents', () => {
  it('saves team and personal agents only after the confirmation, and lists them with tool state', async () => {
    await start(setup({ codexInstalled: true }));
    expect((await call('/api/agents', { scope: 'team', slug: 'rei-mobile', profile: rei })).status).toBe(400);
    expect(existsSync(join(project.dir, '.agents', 'profiles'))).toBe(false);

    const saved = await call('/api/agents', { scope: 'team', slug: 'rei-mobile', profile: rei, confirm: true });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.file).toBe('.agents/profiles/rei-mobile.json');
    const joe = { name: 'Joe', tool: 'claude-code' };
    expect((await call('/api/agents', { scope: 'personal', slug: 'joe', profile: joe, confirm: true })).status).toBe(
      200,
    );
    expect(existsSync(join(home(), '.agents', 'profiles', 'joe.json'))).toBe(true);

    const info = (await call('/api/agents')).json as {
      agents: {
        slug: string;
        scope: string;
        label: string;
        initials: string;
        skills: { name: string; scope: string }[];
      }[];
      tools: { tool: string; installed: boolean | null; setUp: boolean }[];
      runners: { runner: string; installed: boolean | null }[];
      skills: { name: string; scope: string; description: string }[];
    };
    expect(info.agents.map((a) => [a.slug, a.scope, a.label, a.initials])).toEqual([
      ['rei-mobile', 'team', 'Rei – Mobile · Codex', 'RM'],
      ['joe', 'personal', 'Joe · Claude Code', 'J'],
    ]);
    expect(info.agents[0]!.skills).toEqual([
      { name: 'payments', scope: 'project' },
      { name: 'my-style', scope: 'user' },
    ]);
    expect(info.tools.find((t) => t.tool === 'codex')).toMatchObject({ installed: true, setUp: true });
    expect(info.tools.find((t) => t.tool === 'claude-code')).toMatchObject({ installed: false, setUp: false });
    expect(info.tools.find((t) => t.tool === 'antigravity')).toMatchObject({ installed: null });
    expect(info.runners.map((r) => r.runner)).toEqual(['opencode', 'codex', 'custom']);
    expect(info.skills).toContainEqual({ name: 'payments', scope: 'project', description: 'Stripe rules' });
    expect(info.skills.some((s) => s.scope === 'team')).toBe(true);
  });

  it('refuses secrets and unknown keys in a profile, and bad ids or scopes', async () => {
    await start(setup());
    const bad = async (body: object) =>
      (await call('/api/agents', { scope: 'team', slug: 'x', confirm: true, ...body })).status;
    expect(await bad({ profile: { ...rei, name: TOKEN } })).toBe(400);
    expect(await bad({ profile: { ...rei, token: 'abc' } })).toBe(400);
    expect(await bad({ profile: rei, slug: '../../etc' })).toBe(400);
    expect(await bad({ profile: rei, scope: 'global' })).toBe(400);
    expect(existsSync(join(project.dir, '.agents', 'profiles'))).toBe(false);
  });

  it('deletes agents and creates project skills only with the confirmation', async () => {
    await start(setup());
    await call('/api/agents', { scope: 'team', slug: 'rei', profile: rei, confirm: true });
    expect((await call('/api/agents/delete', { scope: 'team', slug: 'rei' })).status).toBe(400);
    expect((await call('/api/agents/delete', { scope: 'team', slug: 'rei', confirm: true })).status).toBe(200);
    expect(existsSync(join(project.dir, '.agents', 'profiles', 'rei.json'))).toBe(false);

    expect((await call('/api/skills', { name: 'checkout', description: 'Checkout flow rules' })).status).toBe(400);
    const made = await call('/api/skills', { name: 'checkout', description: 'Checkout flow rules', confirm: true });
    expect(made.json.file).toBe('.agents/skills/checkout/SKILL.md');
    expect(readFileSync(join(project.dir, '.agents', 'skills', 'checkout', 'SKILL.md'), 'utf8')).toContain(
      'description: Checkout flow rules',
    );
    expect((await call('/api/skills', { name: 'checkout', description: 'again', confirm: true })).status).toBe(400);
    expect((await call('/api/skills', { name: 'Bad Name', description: 'x', confirm: true })).status).toBe(400);
  });

  it('runs a task as an agent with another tool (skills kept) and remembers the choice', async () => {
    await start(setup({ codexInstalled: false }));
    await call('/api/agents', { scope: 'team', slug: 'rei-mobile', profile: rei, confirm: true });
    git('add', '-A');
    git('commit', '-q', '-m', 'agent');
    expect((await call('/api/project')).json.lastAgent).toBeNull();

    // Codex is not installed: the console offers the custom command instead; the profile's skills stay.
    const preview = await call('/api/preview', { taskId: 'T1', mode: 'run', runner: 'custom', agent: 'rei-mobile' });
    expect(preview.status, preview.text).toBe(200);
    expect(preview.json.output).toContain('agent: Rei – Mobile · Custom command (team agent "rei-mobile")');
    expect(preview.json.output).toContain('skills for the coder and reviewer: payments (project), my-style (user');

    const started = await call('/api/runs', { previewId: preview.json.previewId });
    expect(started.status, started.text).toBe(200);
    expect(started.json.label).toBe('Rei – Mobile · Custom command');
    for (let i = 0; i < 200; i++) {
      if (((await call('/api/runs/current')).json.run as { state: string }).state !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const log = (await call('/api/runs/current/stream?from=0')).text;
    expect(log).toContain('Agent profile: \\"Rei – Mobile\\"');
    expect((await call('/api/project')).json.lastAgent).toBe('rei-mobile');
    expect(readFileSync(join(project.dir, '.tossana', 'tmp', 'skills', 'my-style', 'SKILL.md'), 'utf8')).toContain(
      'Short',
    );
  });

  it('refuses an unknown agent in the preview', async () => {
    await start(setup());
    const r = await call('/api/preview', { taskId: 'T1', mode: 'run', runner: 'custom', agent: 'nobody' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('no agent "nobody"');
  });
});
