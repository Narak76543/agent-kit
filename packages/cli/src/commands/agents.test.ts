import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAgentComment } from '@tossana/agents-core';
import { exec } from '../exec.js';
import { taskPrompt } from '../runners.js';
import { CONFIG, TOKEN, cli, fakeApi, fakeExec, tempProject, type TempProject } from '../test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const home = () => join(dirname(project.dir), 'home');
const read = (file: string) => readFileSync(join(project.dir, ...file.split('/')), 'utf8');
const git = (p: TempProject, ...args: string[]) => {
  const r = exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: p.dir });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const agents = (args: string[], opts: { interactive?: boolean } = {}) =>
  cli(['agents', ...args], { cwd: project.dir, exec: fakeExec(), ...opts });

/** The fake agent prints its prompt. */
const AGENT = `process.stdout.write('agent got: ' + process.argv[2] + '\\n');`;

/** A git repo with codex + opencode set up, a project skill and a user skill on "this machine". */
function gitProject() {
  const p = tempProject({
    config: { ...CONFIG, tools: ['opencode', 'codex'], pipeline: { runner: 'opencode' } },
    env: `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\nAGENT_CMD=node "fake agent/agent.js" {prompt}\n`,
  });
  p.write('fake agent/agent.js', AGENT);
  p.write('.gitignore', '.env\n.agents/logs/\n.agents/handoff/\n.tossana/tmp/\n');
  p.write('.opencode/agents/orchestrator.md', 'x');
  p.write('.codex/orchestrator.md', 'x');
  p.write('.agents/skills/payments/SKILL.md', '---\nname: payments\ndescription: Stripe rules\n---\n# Payments\n');
  p.write('app.ts', 'v1');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'add', '-A');
  git(p, 'commit', '-q', '-m', 'init');
  // A user skill in the (temp) home folder: only on this machine.
  p.write('../home/.agents/skills/my-style/SKILL.md', '# My style\nShort functions.\n');
  return p;
}

const taskApi = () =>
  fakeApi()
    .on('GET /v2/task/T1', { id: 'T1', name: 'Login', status: { status: 'to do', type: 'open' }, list: { id: 'L1' } })
    .on('GET /v2/task/T1/comment', { comments: [] })
    .on('POST /v2/task/T1/comment', { id: 9 });

describe('agents create / list / delete', () => {
  it('creates a team agent in the project and lists it with its tool state', async () => {
    project = gitProject();
    const r = await agents([
      'create',
      '--name',
      'Rei – Mobile',
      '--tool',
      'codex',
      '--skills',
      'payments,my-style',
      '--color',
      'blue',
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Saved team agent "rei-mobile": Rei – Mobile · Codex');
    expect(JSON.parse(read('.agents/profiles/rei-mobile.json'))).toEqual({
      version: 1,
      name: 'Rei – Mobile',
      color: 'blue',
      tool: 'codex',
      skills: ['payments', 'my-style'],
      mcp: [],
    });

    const list = await cli(['agents', 'list'], {
      cwd: project.dir,
      exec: fakeExec({ 'codex --version': { code: 0, stdout: 'codex-cli 0.130.0\n' } }),
    });
    expect(list.out).toContain('rei-mobile  Rei – Mobile · Codex  (team; installed codex-cli 0.130.0, set up here)');
    expect(list.out).toContain('skills: payments, my-style');
  });

  it('creates personal agents in the home folder, never in the project', async () => {
    project = gitProject();
    const r = await agents(['create', '--name', 'Joe – Backend', '--tool', 'claude-code', '--personal']);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(home(), '.agents', 'profiles', 'joe-backend.json'))).toBe(true);
    expect(existsSync(join(project.dir, '.agents', 'profiles'))).toBe(false);
    const list = await agents(['list']);
    expect(list.out).toContain(
      'joe-backend  Joe – Backend · Claude Code  (personal; NOT installed, NOT set up in this project)',
    );
  });

  it('refuses bad input: secrets, unknown tools, duplicate ids, ids in the other scope', async () => {
    project = gitProject();
    expect((await agents(['create', '--name', TOKEN, '--tool', 'codex', '--id', 'x'])).err).toContain(
      'looks like a secret',
    );
    expect((await agents(['create', '--name', 'A', '--tool', 'cursor'])).err).toContain('tool');
    expect((await agents(['create', '--name', 'សារ៉ាត់', '--tool', 'codex'])).err).toContain('pass one with --id');
    expect((await agents(['create', '--name', 'A', '--tool', 'codex', '--id', '../x'])).err).toContain(
      'not a valid agent id',
    );
    expect((await agents(['create', '--name', 'Rei', '--tool', 'codex'])).code).toBe(0);
    expect((await agents(['create', '--name', 'Rei', '--tool', 'codex'])).err).toContain('already exists');
    expect((await agents(['create', '--name', 'Rei', '--tool', 'codex', '--personal'])).err).toContain(
      'a team agent "rei" already exists',
    );
    expect((await agents(['create', '--name', 'Rei 2', '--tool', 'opencode', '--id', 'rei', '--replace'])).code).toBe(
      0,
    );
  });

  it('warns about skills this machine does not have', async () => {
    project = gitProject();
    const r = await agents(['create', '--name', 'Rei', '--tool', 'codex', '--skills', 'nope']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('skills not found on this machine: nope');
  });

  it('deletes only with --yes (or a confirmation)', async () => {
    project = gitProject();
    await agents(['create', '--name', 'Rei', '--tool', 'codex']);
    expect((await agents(['delete', 'rei'])).err).toContain('Run again with --yes');
    expect(existsSync(join(project.dir, '.agents', 'profiles', 'rei.json'))).toBe(true);
    expect((await agents(['delete', 'rei', '--yes'])).code).toBe(0);
    expect(existsSync(join(project.dir, '.agents', 'profiles', 'rei.json'))).toBe(false);
    expect((await agents(['delete', 'rei', '--yes'])).err).toContain('no team agent "rei"');
  });

  it('lists an invalid profile file with its error instead of failing', async () => {
    project = gitProject();
    project.write('.agents/profiles/broken.json', { name: 'B', tool: 'codex', token: 'x' });
    const r = await agents(['list']);
    expect(r.out).toMatch(/✗ broken \(team\): .*Unrecognized key/s);
  });
});

describe('run --agent', () => {
  const run = (args: string[]) => cli(['run', ...args], { cwd: project.dir, api: taskApi(), exec });

  it('dry run: shows the agent, its skills and where they come from', async () => {
    project = gitProject();
    await agents([
      'create',
      '--name',
      'Rei – Mobile',
      '--tool',
      'codex',
      '--skills',
      'payments,my-style,frontend-master',
    ]);
    const r = await run(['--task', 'T1', '--agent', 'rei-mobile', '--dry-run']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('agent: Rei – Mobile · Codex (team agent "rei-mobile")');
    expect(r.out).toContain(
      'skills for the coder and reviewer: payments (project), my-style (user, copied to .tossana/tmp/skills/my-style/SKILL.md), ' +
        'frontend-master (team, copied to .tossana/tmp/skills/frontend-master/SKILL.md)',
    );
    expect(r.out).toContain('$ codex exec');
    expect(r.out).toContain('Agent profile: \\"Rei – Mobile\\"');
  });

  it('runs with the profile: handoff entry, staged skills, prompt; --runner keeps the skills', async () => {
    project = gitProject();
    await agents([
      'create',
      '--name',
      'Rei – Mobile',
      '--tool',
      'codex',
      '--skills',
      'payments,my-style',
      '--mcp',
      'figma',
    ]);
    const r = await run(['--task', 'T1', '--agent', 'rei-mobile', '--runner', 'custom']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`agent got: ${taskPrompt('T1', 'Rei – Mobile')}`);

    const handoff = read('.agents/handoff/T1.md');
    expect(handoff).toMatch(/— Run started with custom as "Rei – Mobile"\n/);
    expect(handoff).toContain('Agent profile: Rei – Mobile (team agent "rei-mobile"), tool Custom command.');
    expect(handoff).toContain('Skills for the `coder` and `reviewer`');
    expect(handoff).toContain('- payments: `.agents/skills/payments/SKILL.md`');
    expect(handoff).toContain('- my-style: `.tossana/tmp/skills/my-style/SKILL.md`');
    expect(handoff).toContain('MCP servers for this agent: figma.');
    expect(read('.tossana/tmp/skills/my-style/SKILL.md')).toContain('Short functions.');
    expect(r.err).toContain(
      '[run] warning: figma is not set up in this project. Add it with: tossana-agents init --figma',
    );
  });

  it('stops before changing anything when a skill is missing, the agent is unknown or its tool is not set up', async () => {
    project = gitProject();
    project.write('.agents/profiles/gone.json', { name: 'Gone', tool: 'codex', skills: ['nope'] });
    project.write('.agents/profiles/cc.json', { name: 'CC', tool: 'claude-code' });
    expect((await run(['--task', 'T1', '--agent', 'gone'])).err).toContain('skills that are not available here: nope');
    expect((await run(['--task', 'T1', '--agent', 'who'])).err).toContain('no agent "who". Agents: cc, gone');
    expect((await run(['--task', 'T1', '--agent', 'cc'])).err).toContain('claude-code is not set up in this project');
    expect(git(project, 'branch', '--show-current')).toBe('main');
    expect(existsSync(join(project.dir, '.agents', 'handoff'))).toBe(false);
  });

  it('resume --agent: the resume comment names the agent and the handoff records it', async () => {
    project = gitProject();
    await agents(['create', '--name', 'Rei – Mobile', '--tool', 'codex', '--skills', 'payments']);
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'add agent Rei');
    git(project, 'switch', '-q', '-c', 'task/T1');
    git(project, 'switch', '-q', 'main');
    const api = fakeApi()
      .on('GET /v2/task/T1', {
        id: 'T1',
        name: 'Login',
        status: { status: 'coding', type: 'custom' },
        list: { id: 'L1' },
      })
      .on('GET /v2/task/T1/comment', { comments: [] })
      .on('POST /v2/task/T1/comment', { id: 9 });
    const r = await cli(['run', '--task', 'T1', '--resume', '--agent', 'rei-mobile', '--runner', 'custom'], {
      cwd: project.dir,
      api,
      exec,
    });
    expect(r.code, r.err).toBe(0);
    const posted = (api.calls.find((c) => c.method === 'POST')!.body as { comment_text: string }).comment_text;
    expect(parseAgentComment(posted)).toMatchObject({ result: 'STARTED', by: 'Rei – Mobile · Custom command' });
    expect(read('.agents/handoff/T1.md')).toMatch(/— Resumed with custom as "Rei – Mobile" after an earlier run\n/);
    expect(r.out).toContain('Agent profile: "Rei – Mobile"');
  });

  it('--no-agent still works next to --agent <id>', async () => {
    project = gitProject();
    const r = await run(['--task', 'T1', '--no-agent', '--dry-run']);
    expect(r.out).toContain('(no agent is started: --no-agent)');
  });
});

describe('comments name the agent and tool', () => {
  it('cu comment adds [BY: …] from the latest run entry; plain notes are unchanged', async () => {
    project = gitProject();
    project.write(
      '.agents/handoff/T1.md',
      '# Handoff\n\n## 2026-10-13T08:00:00.000Z — Run started with opencode\n\nx\n\n' +
        '## 2026-10-13T09:00:00.000Z — Resumed with codex as "Rei – Mobile" after opencode\n\ny\n',
    );
    const api = taskApi();
    const post = (text: string) => cli(['clickup', 'comment', 'T1', text], { cwd: project.dir, api });
    await post('[AGENT: coder] [RESULT: DONE_CODING] [ROUND: 2]\nSummary: done\nNext: reviewer');
    await post('Just a note');
    const sent = api.calls
      .filter((c) => c.method === 'POST')
      .map((c) => (c.body as { comment_text: string }).comment_text);
    expect(parseAgentComment(sent[0]!)?.by).toBe('Rei – Mobile · Codex');
    expect(sent[1]).toBe('Just a note');
    expect(read('.agents/handoff/T1.md')).toContain('[BY: Rei – Mobile · Codex]');
  });

  it('without an agent profile the tool alone is named', async () => {
    project = gitProject();
    project.write('.agents/handoff/T1.md', '## 2026-10-13T08:00:00.000Z — Run started with claude-code\n');
    const api = taskApi();
    await cli(['clickup', 'comment', 'T1', '[AGENT: tester] [RESULT: PASS] [ROUND: 1]'], { cwd: project.dir, api });
    const body = api.calls.find((c) => c.method === 'POST')!.body as { comment_text: string };
    expect(body.comment_text).toBe('[AGENT: tester] [RESULT: PASS] [ROUND: 1] [BY: Claude Code]');
  });
});
