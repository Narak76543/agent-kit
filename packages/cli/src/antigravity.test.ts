import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@tossana/agents-core';
import {
  addAntigravityRules,
  agySettingsFile,
  antigravityRules,
  antigravityState,
  legacyAntigravityRules,
} from './antigravity.js';
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
      args: ['-p', 'Work on T1', '--agent', 'orchestrator', '--add-dir', project.dir, '--print-timeout', '120m'],
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

  it('preflight: missing rules, then ready (no trust needed: runs pass --add-dir)', () => {
    project = tempProject();
    project.write('package.json', '{}'); // a Node project: agents call the kit with npx
    const a = antigravityAdapter(fakeExec(), project.dir, { home: home(), config });
    expect(a.preflight!()).toContain('Allow them with: npx tossana-agents antigravity permissions');
    addAntigravityRules(home(), antigravityRules(config, 'npx tossana-agents'));
    // Setup is complete; what is left is the live agent check (agy-check.test.ts).
    expect(a.preflight!()).toContain('the agents are not checked with this agy version yet');
  });
});

describe('antigravity permissions', () => {
  // The command texts agy 1.3.3 showed in a real run, and what must stay refused. The same 18 were checked against
  // these rules with a throwaway agy agent, one command per session (PROGRESS.md); this keeps the rules honest.
  const ALLOWED = [
    'git log -n 5 --oneline',
    'git branch -a',
    'git status --porcelain',
    'git commit -m "z8qu5d3jkp: use AppText and design tokens in tab screens"',
    'pnpm.cmd typecheck',
    'pnpm typecheck',
    'npx.cmd tossana-agents clickup get T1',
    'npx tossana-agents clickup get T1',
    'npx.cmd tossana-agents run --task T1 --no-agent',
    'git add -A',
    'npx.cmd tossana-agents clickup comment T1 --file .tossana/tmp/T1-coder.md',
    'git branch --show-current',
    'pnpm.cmd lint',
    'pnpm test',
    'node -v',
    'pnpm.cmd --version',
    'git --version',
  ];
  const REFUSED = [
    'git push',
    'git push origin main',
    'git commit --amend -m "x"',
    'git reset --hard HEAD~1',
    'git rebase main',
    'git branch -D main',
    'npx.cmd tossana-agents clickup get T1; git push',
    'git log -n 1 && git push',
    'git commit -m "x" && git push',
    'git commit -m "$(git push)"',
    'npx tossana-agents run --task T1',
    'git checkout -- src/app.ts',
    'git clean -fd',
    'pnpm.cmd install',
    'git log | sh',
    'node scripts/x.js',
    'node -e "process.exit(0)"',
    'node -v && git push',
  ];
  const matches = (rules: string[], command: string) =>
    rules.some((r) => new RegExp(/^command\(regex:(.*)\)$/.exec(r)![1]!).test(command));

  it('allows the exact forms agents run (npx.cmd, pnpm.cmd, quoted commit messages, git options)', () => {
    const rules = antigravityRules(
      parseConfig({ ...CONFIG, commands: { lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' } }),
      'npx tossana-agents',
    );
    for (const c of ALLOWED) expect(matches(rules, c), c).toBe(true);
  });

  it('never allows push, history rewrites, deleting branches, chained or substituted commands', () => {
    const rules = antigravityRules(
      parseConfig({ ...CONFIG, commands: { lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' } }),
      'npx tossana-agents',
    );
    for (const c of REFUSED) expect(matches(rules, c), c).toBe(false);
    expect(rules.every((r) => r.startsWith('command(regex:^') && r.endsWith('$)'))).toBe(true);
  });

  it("allows the project's own package.json scripts, never package-manager commands", () => {
    const pnpmConfig = parseConfig({
      ...CONFIG,
      commands: { install: 'pnpm install', lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' },
    });
    const rules = antigravityRules(pnpmConfig, 'npx tossana-agents', [
      'i18n:check',
      'lint',
      'test',
      'install',
      'start',
    ]);
    for (const c of [
      'pnpm i18n:check',
      'pnpm.cmd i18n:check',
      'pnpm run i18n:check',
      'pnpm.cmd run i18n:check',
      'pnpm test -- tests/i18n.test.ts',
    ]) {
      expect(matches(rules, c), c).toBe(true);
    }
    for (const c of [
      'pnpm add left-pad',
      'pnpm install',
      'pnpm run install',
      'pnpm dlx some-tool',
      'pnpm exec rm -rf /',
      'pnpm deploy',
      'pnpm unknown-script',
      'pnpm i18n:check && git push',
      'pnpm i18n:check; git push',
      'npm run i18n:check',
      'pnpm start', // long-running: servers, simulators and watchers are left out
    ]) {
      expect(matches(rules, c), c).toBe(false);
    }
    // No install command (e.g. Flutter): no script rule.
    expect(antigravityRules(parseConfig(CONFIG), 'tossana-agents', ['i18n:check']).join(' ')).not.toContain('i18n');
  });

  it('uses the global command when the project is not a Node project, and escapes project commands', () => {
    const rules = antigravityRules(
      parseConfig({ ...CONFIG, commands: { test: 'flutter test --coverage' } }),
      'tossana-agents',
    );
    expect(matches(rules, 'tossana-agents.cmd clickup get T1')).toBe(true);
    expect(matches(rules, 'flutter test --coverage')).toBe(true);
    expect(matches(rules, 'flutter.cmd test --coverage')).toBe(true);
    expect(matches(rules, 'flutter test --coverage --update-goldens')).toBe(false);
  });

  it('shows a diff, writes nothing without --yes, then replaces only the old kit rules (backup kept)', async () => {
    project = tempProject();
    project.write('package.json', '{}');
    const legacy = legacyAntigravityRules(parseConfig(CONFIG), 'npx tossana-agents');
    project.write('../home/.gemini/antigravity-cli/settings.json', {
      model: 'x',
      trustedWorkspaces: [project.dir],
      permissions: { allow: ['command(ffmpeg -version)', ...legacy, 'command(git)'] },
    });
    const cmd = (args: string[], interactive = false) =>
      cli(['antigravity', 'permissions', ...args], { cwd: project.dir, exec: fakeExec(), interactive });

    const no = await cmd([]);
    expect(no.code).not.toBe(0);
    expect(no.out).toContain('- command(git log)');
    expect(no.out).toContain('+ command(regex:^git commit -m "');
    expect(no.err).toContain('nothing changed');
    expect(settings().permissions).toEqual({ allow: ['command(ffmpeg -version)', ...legacy, 'command(git)'] });

    const yes = await cmd(['--yes']);
    expect(yes.code, yes.err).toBe(0);
    expect(yes.out).toMatch(/Added \d+, removed \d+ rule\(s\)\. Backup: .*settings\.json\.bak-/);
    expect(yes.err).toContain('also allow "git push" or any command: command(git)');
    const s = settings() as { model: string; permissions: { allow: string[] } };
    expect(s.model).toBe('x');
    // The user's own rules stay (even the broad one: doctor warns about it, the kit does not delete it).
    expect(s.permissions.allow.slice(0, 2)).toEqual(['command(ffmpeg -version)', 'command(git)']);
    for (const r of legacy) expect(s.permissions.allow).not.toContain(r);
    const state = antigravityState(home(), project.dir, antigravityRules(parseConfig(CONFIG), 'npx tossana-agents'));
    expect(state.missing).toEqual([]);
    expect((await cmd(['--yes'])).out).toContain('rules are already in');
  });

  it('doctor checks trust and rules when agy is installed, and fails them only for the antigravity runner', async () => {
    project = tempProject({ config: { ...CONFIG, tools: ['antigravity'], pipeline: { runner: 'antigravity' } } });
    const exec = fakeExec({ 'agy --version': { code: 0, stdout: '1.3.3\n' } });
    const d = await cli(['doctor'], { cwd: project.dir, exec, api: fakeApi() });
    expect(d.out).toMatch(/Antigravity CLI \(agy\) 1\.3\.3/);
    expect(d.out).not.toContain('trusts this folder');
    expect(d.out).toMatch(/(❌|\[FAIL\]) Antigravity allows the commands the agents need/);
  });
});
