import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@tossana/agents-core';
import { addAntigravityRules, agySettingsFile, antigravityRules, antigravityState } from './antigravity.js';
import { readManifest } from './kit-manifest.js';
import { antigravityAdapter } from './runners.js';
import { CONFIG, cli, fakeApi, fakeExec, tempProject, type TempProject } from './test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const home = () => join(dirname(project.dir), 'home');
const config = parseConfig({ ...CONFIG, commands: { lint: 'pnpm lint', test: 'pnpm test' } });
const settings = () => JSON.parse(readFileSync(agySettingsFile(home()), 'utf8')) as Record<string, unknown>;

const LIST = {
  id: 'L1',
  name: 'Mobile',
  statuses: ['to do', 'coding', 'in review', 'testing', 'ready for review'].map((status) => ({
    status,
    type: 'custom',
  })),
};

describe('Antigravity agents layout', () => {
  it('init writes .agents/agents/<role>/agent.md, plus the orchestrator main agent', async () => {
    project = tempProject({ config: { ...CONFIG, tools: ['antigravity'] } });
    const r = await cli(['init', '--yes', '--no-doctor'], {
      cwd: project.dir,
      api: fakeApi().on('GET /v2/list/L1', LIST),
    });
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(join(project.dir, '.agents', 'agents')).sort()).toEqual([
      'coder',
      'orchestrator',
      'reviewer',
      'tester',
    ]);
    const orchestrator = readFileSync(join(project.dir, '.agents/agents/orchestrator/agent.md'), 'utf8');
    expect(orchestrator).toMatch(/^name: orchestrator$/m);
    expect(orchestrator).toMatch(/^mainAgent: true$/m);
    expect(orchestrator).toMatch(/^subagent: false$/m);
    expect(orchestrator).toContain('  - invoke_subagent');
    const coder = readFileSync(join(project.dir, '.agents/agents/coder/agent.md'), 'utf8');
    expect(coder).toMatch(/^mainAgent: false$/m);
    expect(coder).toMatch(/^subagent: true$/m);
  });

  it('update moves the old flat files, keeps local edits, and leaves files the kit did not write', async () => {
    project = tempProject({ config: { ...CONFIG, tools: ['antigravity'] } });
    const api = fakeApi().on('GET /v2/list/L1', LIST);
    await cli(['init', '--yes', '--no-doctor'], { cwd: project.dir, api });
    // Turn the project back into the old layout, as an older kit version wrote it.
    const manifestFile = join(project.dir, '.agents/kit/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { files: Record<string, string> };
    const files = Object.fromEntries(Object.entries(manifest.files).filter(([f]) => !f.startsWith('.agents/agents/')));
    for (const role of ['coder', 'reviewer', 'tester', 'orchestrator']) {
      const path = `.agents/agents/${role}/agent.md`;
      const content = readFileSync(join(project.dir, path), 'utf8');
      rmSync(join(project.dir, '.agents/agents', role), { recursive: true });
      if (role === 'orchestrator') continue; // older kits had no orchestrator agent
      project.write(`.agents/agents/${role}.md`, role === 'tester' ? `${content}\nMy local note.\n` : content);
      files[`.agents/agents/${role}.md`] = manifest.files[path]!;
    }
    manifest.files = files;
    project.write('.agents/kit/manifest.json', manifest);
    project.write('.agents/agents/my-own.md', '---\nname: my-own\n---\nmine');

    const r = await cli(['update'], { cwd: project.dir, api });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('moved    .agents/agents/coder.md → .agents/agents/coder/agent.md');
    expect(r.out).toContain('kept     .agents/agents/tester/agent.md');
    for (const role of ['coder', 'reviewer', 'tester', 'orchestrator']) {
      expect(existsSync(join(project.dir, `.agents/agents/${role}/agent.md`)), role).toBe(true);
      expect(existsSync(join(project.dir, `.agents/agents/${role}.md`)), role).toBe(false);
    }
    expect(readFileSync(join(project.dir, '.agents/agents/tester/agent.md'), 'utf8')).toContain('My local note.');
    expect(existsSync(join(project.dir, '.agents/agents/my-own.md'))).toBe(true);
    expect(Object.keys(readManifest(project.dir)!.files).filter((f) => f.startsWith('.agents/agents/'))).toEqual([
      '.agents/agents/coder/agent.md',
      '.agents/agents/orchestrator/agent.md',
      '.agents/agents/reviewer/agent.md',
      '.agents/agents/tester/agent.md',
    ]);

    // doctor names the flat file Antigravity may not load.
    const d = await cli(['doctor'], { cwd: project.dir, api, exec: fakeExec() });
    expect(d.out).toContain('Old flat files: my-own.md');
  });
});

describe('agy run adapter', () => {
  it('runs the orchestrator headless with the kit timeout, never skipping permissions', () => {
    project = tempProject();
    const a = antigravityAdapter(fakeExec(), project.dir, { home: home(), config });
    expect(a.headless).toBe(true);
    const cmd = a.buildCommand({ agent: 'orchestrator', prompt: 'Work on T1', cwd: project.dir });
    expect(cmd).toEqual({
      cmd: 'agy',
      args: ['-p', 'Work on T1', '--agent', 'orchestrator', '--print-timeout', '120m'],
    });
    expect(cmd.args.join(' ')).not.toMatch(/dangerously|skip-permissions/);
  });

  it('is installed when agy answers --version', async () => {
    project = tempProject();
    const yes = antigravityAdapter(fakeExec({ 'agy --version': { code: 0, stdout: '1.3.3\n' } }), project.dir, {
      home: home(),
      config,
    });
    const no = antigravityAdapter(fakeExec(), project.dir, { home: home(), config });
    expect(await yes.isInstalled()).toBe(true);
    expect(await no.isInstalled()).toBe(false);
  });

  it('preflight: untrusted folder, then missing rules, then ready', () => {
    project = tempProject();
    project.write('package.json', '{}'); // a Node project: agents call the kit with npx
    const a = antigravityAdapter(fakeExec(), project.dir, { home: home(), config });
    expect(a.preflight!()).toContain('not a trusted Antigravity workspace');
    project.write('../home/.gemini/antigravity-cli/settings.json', {
      trustedWorkspaces: [project.dir.replace(/\\/g, '/')],
    });
    expect(a.preflight!()).toContain('Allow them with: npx tossana-agents antigravity permissions');
    addAntigravityRules(home(), antigravityRules(config, 'npx tossana-agents'));
    // Setup is complete; what is left is the live agent check (agy-check.test.ts).
    expect(a.preflight!()).toContain('the agents are not checked with this agy version yet');
  });
});

describe('antigravity permissions', () => {
  it('lists narrow rules: kit clickup, read-only git, add/commit, the project commands; never push or *', () => {
    const rules = antigravityRules(config, 'npx tossana-agents');
    expect(rules).toContain('command(npx tossana-agents clickup)');
    expect(rules).toContain('command(git commit -m)');
    expect(rules).toContain('command(pnpm lint)');
    expect(rules).toContain('command(pnpm test)');
    expect(rules.join(' ')).not.toMatch(/push|\*|reset|rebase|merge|clean|command\(git\)/);
  });

  it('adds only the missing rules after a yes, with a backup, keeping everything else', async () => {
    project = tempProject();
    project.write('package.json', '{}');
    project.write('../home/.gemini/antigravity-cli/settings.json', {
      model: 'x',
      trustedWorkspaces: [project.dir],
      permissions: { allow: ['command(git status)', 'command(git)'] },
    });
    const cmd = (args: string[], interactive = false) =>
      cli(['antigravity', 'permissions', ...args], { cwd: project.dir, exec: fakeExec(), interactive });

    const no = await cmd([]);
    expect(no.code).not.toBe(0);
    expect(no.out).toContain('  command(npx tossana-agents clickup)');
    expect(no.out).not.toContain('  command(git status)\n');
    expect(settings().permissions).toEqual({ allow: ['command(git status)', 'command(git)'] });

    const yes = await cmd(['--yes']);
    expect(yes.code, yes.err).toBe(0);
    expect(yes.out).toMatch(/Added \d+ rule\(s\)\. Backup: .*settings\.json\.bak-/);
    expect(yes.err).toContain('also allow "git push" or any command: command(git)');
    const s = settings() as { model: string; permissions: { allow: string[] } };
    expect(s.model).toBe('x');
    expect(s.permissions.allow.filter((r) => r === 'command(git status)')).toHaveLength(1);
    const state = antigravityState(home(), project.dir, antigravityRules(parseConfig(CONFIG), 'npx tossana-agents'));
    expect(state.missing).toEqual([]);
    expect((await cmd(['--yes'])).out).toContain('rules are already in');
  });

  it('doctor checks trust and rules when agy is installed, and fails them only for the antigravity runner', async () => {
    project = tempProject({ config: { ...CONFIG, tools: ['antigravity'], pipeline: { runner: 'antigravity' } } });
    const exec = fakeExec({ 'agy --version': { code: 0, stdout: '1.3.3\n' } });
    const d = await cli(['doctor'], { cwd: project.dir, exec, api: fakeApi() });
    expect(d.out).toMatch(/Antigravity CLI \(agy\) 1\.3\.3/);
    expect(d.out).toMatch(/(❌|\[FAIL\]) Antigravity trusts this folder/);
    expect(d.out).toMatch(/(❌|\[FAIL\]) Antigravity allows the commands the agents need/);
  });
});
