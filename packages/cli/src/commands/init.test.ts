import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { exec } from '../exec.js';
import { readManifest } from '../kit-manifest.js';
import type { Prompts } from '../prompts.js';
import { MANAGED_TEXT } from '../templates.js';
import { KIT_VERSION } from '../version.js';
import { LIST, TOKEN, cli, fakeApi, tempProject, type TempProject } from '../test-utils.test-helper.js';
import { ensureGitignore, mapStatuses, setEnvValue } from './init.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const EKMONG_LIST = {
  id: 'L1',
  name: 'Mobile',
  statuses: [
    { status: 'to do', type: 'open' },
    { status: 'coding', type: 'custom' },
    { status: 'in review', type: 'custom' },
    { status: 'testing', type: 'custom' },
    { status: 'ready for narak', type: 'custom' },
    { status: 'complete', type: 'closed' },
  ],
};

const api = (list: object = LIST) =>
  fakeApi()
    .on('GET /v2/user', { user: { id: 777, username: 'dara' } })
    .on('GET /v2/list/L1', list);

/** A React Native project like EKMONG_MOBILE, before the kit. */
function rnProject(env = `CLICKUP_API_TOKEN=${TOKEN}\n`) {
  const p = tempProject({ config: null, env });
  p.write('package.json', {
    name: 'ekmong-mobile',
    dependencies: { 'react-native': '0.86.0', expo: '57' },
    scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'jest' },
  });
  p.write('pnpm-lock.yaml', '');
  p.write('src/features/cart/index.ts', '');
  p.write('src/design/index.ts', '');
  return p;
}

const read = (p: TempProject, file: string) => readFileSync(join(p.dir, ...file.split('/')), 'utf8');

/** All files (relative path → content), for "nothing changed" checks. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const frontmatter = (md: string) => parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(md)![1]!) as Record<string, unknown>;

describe('init --yes', () => {
  it('sets up a React Native project like EKMONG_MOBILE', async () => {
    project = rnProject();
    const r = await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api(EKMONG_LIST) });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);

    const config = JSON.parse(read(project, 'agent.config.json'));
    expect(config).toEqual({
      $schema: './node_modules/@tossana/agents/schema/agent.config.schema.json',
      version: 1,
      project: { name: 'ekmong-mobile', type: 'react-native', skill: 'mobile-master' },
      clickup: {
        listId: 'L1',
        statuses: {
          todo: 'to do',
          coding: 'coding',
          review: 'in review',
          testing: 'testing',
          human: 'ready for narak',
        },
      },
      commands: { install: 'pnpm install', lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' },
      figma: { enabled: false },
      pipeline: {
        maxRounds: 5,
        branchPrefix: 'task/',
        baseBranch: 'main',
        requireCleanGit: true,
        runner: 'opencode',
        timeoutMinutes: 120,
      },
    });

    expect(read(project, '.env')).toBe(`CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\n`);
    expect(read(project, '.env.example')).toContain('CLICKUP_API_TOKEN=\n');
    expect(read(project, '.gitignore')).toContain(
      '.env\n.env.*\n!.env.example\n.agents/handoff/\n.agents/logs/\n.agents/tmp/',
    );

    for (const f of ['orchestrator', 'coder', 'reviewer', 'tester']) {
      expect(existsSync(join(project.dir, '.opencode', 'agents', `${f}.md`))).toBe(true);
    }
    expect(read(project, '.agents/skills/mobile-master/SKILL.md')).toContain('name: mobile-master');
    const startTask = read(project, '.agents/skills/start-task/SKILL.md');
    expect(
      startTask.startsWith(`---
# ${MANAGED_TEXT(KIT_VERSION)}
name: start-task
`),
    ).toBe(true);
    expect(startTask).toContain('`npx tossana-agents run --task <taskId> --no-agent`');
    expect(startTask).toContain('Stop at "ready for narak"');
    expect(read(project, '.agents/agents/reviewer.md')).not.toMatch(/write_to_file|replace_file_content/);
    expect(read(project, '.agents/agents/tester.md')).toContain('`npx tossana-agents clickup status`');
    const agents = read(project, 'AGENTS.md');
    expect(agents.startsWith(`<!-- ${MANAGED_TEXT(KIT_VERSION)} -->\n# AGENTS.md`)).toBe(true);
    expect(agents).toContain('**ready for narak**');
    expect(agents).toContain('`pnpm lint` · `pnpm typecheck` · `pnpm test`');
    expect(agents).toContain('\n<!-- PROJECT -->\n\n# Project: ekmong-mobile');
    expect(agents).toMatch(/src\/\n {2}design\/\n {2}features\//);
    expect(agents).toContain('`npx tossana-agents clickup`');

    const manifest = readManifest(project.dir)!;
    expect(manifest.kitVersion).toBe(KIT_VERSION);
    expect(Object.keys(manifest.files)).toEqual([
      '.agents/agents/coder.md',
      '.agents/agents/reviewer.md',
      '.agents/agents/tester.md',
      '.agents/skills/explore/SKILL.md',
      '.agents/skills/mobile-master/SKILL.md',
      '.agents/skills/start-task/SKILL.md',
      '.opencode/agents/coder.md',
      '.opencode/agents/orchestrator.md',
      '.opencode/agents/reviewer.md',
      '.opencode/agents/tester.md',
      'AGENTS.md',
    ]);
    expect(r.out).not.toContain(TOKEN);
  });

  it('is idempotent: a second run changes nothing', async () => {
    project = rnProject();
    project.write('.gitignore', 'node_modules\n');
    await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    const before = snapshot(project.dir);
    const r = await cli(['init', '--yes', '--no-doctor'], { cwd: project.dir, api: api() });
    expect(r.code).toBe(0);
    expect(snapshot(project.dir)).toEqual(before);
    expect(r.out).toContain('11 file(s) already up to date');
    expect(r.out).not.toContain('Wrote agent.config.json');
    expect(r.out).not.toContain('Updated .gitignore');
  });

  it('keeps an existing AGENTS.md byte for byte (CRLF too) below the marker, once', async () => {
    project = rnProject();
    const old =
      '# AGENTS.md — rules for every AI agent in this repo\r\n\r\n## 1. Project overview\r\nEkmong Mobile...\r\n';
    project.write('AGENTS.md', old);
    await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    const first = read(project, 'AGENTS.md');
    expect(first.endsWith(`<!-- PROJECT -->\n\n${old}`)).toBe(true);
    await cli(['init', '--yes', '--no-doctor'], { cwd: project.dir, api: api() });
    expect(read(project, 'AGENTS.md')).toBe(first);
    expect(first.match(/^<!-- PROJECT -->$/gm)).toHaveLength(1);
  });

  it('only rewrites the kit part of AGENTS.md; the project part is never touched', async () => {
    project = rnProject();
    await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    const text = read(project, 'AGENTS.md');
    project.write('AGENTS.md', `${text}\n## My own rule\nUse tabs.\n`);
    project.write('agent.config.json', read(project, 'agent.config.json').replace('"maxRounds": 5', '"maxRounds": 3'));
    await cli(['init', '--yes', '--no-doctor'], { cwd: project.dir, api: api() });
    const after = read(project, 'AGENTS.md');
    expect(after).toContain('(max 3 rounds)');
    expect(after).toContain('## My own rule\nUse tabs.\n');
  });

  it('backs up agent files that existed before the kit, then replaces them', async () => {
    project = rnProject();
    project.write('.opencode/agents/coder.md', '---\ndescription: old coder\nmode: subagent\n---\nold\n');
    const r = await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    expect(read(project, '.opencode/agents/coder.md')).toContain('You are the **coder**');
    const line = r.out.split('\n').find((l) => l.includes('.opencode/agents/coder.md'))!;
    expect(line).toMatch(
      /replaced .*old version saved to \.agents\/kit\/backup\/2026-10-09T12-00-00-000Z\/\.opencode\/agents\/coder\.md/,
    );
    expect(read(project, '.agents/kit/backup/2026-10-09T12-00-00-000Z/.opencode/agents/coder.md')).toContain(
      'old coder',
    );
  });

  it('keeps kit files you edited (unless --force)', async () => {
    project = rnProject();
    await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    const edited = `${read(project, '.opencode/agents/tester.md')}\nMy extra rule.\n`;
    project.write('.opencode/agents/tester.md', edited);
    project.write('agent.config.json', read(project, 'agent.config.json').replace('"maxRounds": 5', '"maxRounds": 4'));

    let r = await cli(['init', '--yes', '--no-doctor'], { cwd: project.dir, api: api() });
    expect(read(project, '.opencode/agents/tester.md')).toBe(edited);
    expect(r.out).toMatch(/kept\s+\.opencode\/agents\/tester\.md \(your version kept/);
    expect(read(project, '.opencode/agents/orchestrator.md')).toContain('max 4 rounds');

    r = await cli(['init', '--yes', '--force', '--no-doctor'], { cwd: project.dir, api: api() });
    expect(read(project, '.opencode/agents/tester.md')).not.toContain('My extra rule.');
    expect(r.out).toMatch(/replaced\s+\.opencode\/agents\/tester\.md \(old version saved/);
  });

  it('works without a token when --list is given, using default statuses', async () => {
    project = rnProject('');
    const r = await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    expect(r.code).toBe(0);
    expect(r.err).toContain('No ClickUp token: using the default status names');
    expect(JSON.parse(read(project, 'agent.config.json')).clickup.statuses.human).toBe('ready for review');
  });

  it('explains what is missing without a list', async () => {
    project = rnProject('');
    const r = await cli(['init', '--yes'], { cwd: project.dir, api: api() });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no ClickUp token and no list');
  });

  it('warns about statuses missing on the list', async () => {
    project = rnProject();
    const r = await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], {
      cwd: project.dir,
      api: api({ ...LIST, statuses: LIST.statuses.slice(0, 2) }),
    });
    expect(r.err).toContain(
      'the list has no status for: review ("in review"), testing ("testing"), human ("ready for review")',
    );
    expect(r.err).toContain('List settings → Statuses');
  });

  it('refuses to ask questions without a terminal', async () => {
    project = rnProject();
    const r = await cli(['init'], { cwd: project.dir });
    expect(r.err).toContain('pass --yes');
  });

  it('runs doctor at the end', async () => {
    project = rnProject();
    const r = await cli(['init', '--yes', '--list', 'L1'], { cwd: project.dir, api: api() });
    expect(r.out).toContain('tossana-agents doctor');
    expect(r.out).toMatch(/✅ Kit files present/);
  });

  it('uses the global command and no $schema in a non-Node project', async () => {
    project = tempProject({ config: null });
    project.write('pubspec.yaml', 'name: app\n');
    await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    const config = JSON.parse(read(project, 'agent.config.json'));
    expect(config.$schema).toBeUndefined();
    expect(config.project).toMatchObject({ type: 'flutter', skill: 'flutter-master' });
    expect(read(project, '.opencode/agents/coder.md')).toContain('`cu` = `tossana-agents clickup`');
    expect(read(project, '.opencode/agents/tester.md')).toContain('"*_test.dart": allow');
  });
});

describe('generated OpenCode agents', () => {
  it('have valid frontmatter with default-deny permissions and no "ask" rules', async () => {
    project = rnProject();
    await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    for (const name of ['orchestrator', 'coder', 'reviewer', 'tester']) {
      const md = read(project, `.opencode/agents/${name}.md`);
      expect(md).toMatch(new RegExp(`^---\\n# ${MANAGED_TEXT(KIT_VERSION).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
      expect(md).not.toMatch(/\{\{/);
      const fm = frontmatter(md);
      expect(fm.description).toEqual(expect.any(String));
      expect(fm.mode).toBe(name === 'orchestrator' ? 'primary' : 'subagent');
      const perm = fm.permission as Record<string, unknown>;
      expect(Object.keys(perm)[0]).toBe('*');
      expect(perm['*']).toBe('deny');
      const bash = perm.bash as Record<string, string>;
      expect(Object.entries(bash)[0]).toEqual(['*', 'deny']);
      expect(JSON.stringify(perm)).not.toContain('"ask"');
      expect(bash['git push*']).toBe('deny');
      expect(bash['*api.clickup.com*']).toBe('deny');
      // Safety denies come after the allows (last match wins).
      const keys = Object.keys(bash);
      expect(keys.indexOf('git push*')).toBeGreaterThan(keys.indexOf('git diff*'));
      expect((perm.read as Record<string, string>)['*.env']).toBe('deny');
    }
  });

  it('give each agent only its own commands', async () => {
    project = rnProject();
    await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    const perm = (name: string) =>
      frontmatter(read(project, `.opencode/agents/${name}.md`)).permission as Record<string, Record<string, string>>;

    const orch = perm('orchestrator');
    expect(orch.bash!['npx tossana-agents clickup *']).toBe('allow');
    expect(orch.bash!['*tossana-agents clickup status *done*']).toBe('deny');
    expect(orch.task).toEqual({ '*': 'deny', coder: 'allow', reviewer: 'allow', tester: 'allow' });
    expect(orch.edit!['*']).toBe('deny');
    expect(orch.edit!['.agents/tmp/*']).toBe('allow');

    const coder = perm('coder');
    expect(coder.bash!['pnpm lint*']).toBe('allow');
    expect(coder.bash!['pnpm install*']).toBe('allow');
    expect(coder.bash!['npx tossana-agents clickup comment *']).toBe('allow');
    expect(coder.bash!['*tossana-agents clickup status*']).toBe('deny');
    expect(coder.edit!['.opencode/*']).toBe('deny');
    expect(coder.edit!['agent.config.json']).toBe('deny');
    const coderEdit = Object.keys(coder.edit!);
    expect(coderEdit.lastIndexOf('.agents/tmp/*')).toBeGreaterThan(coderEdit.indexOf('.agents/*'));

    const reviewer = perm('reviewer');
    expect(reviewer.bash!['pnpm lint*']).toBeUndefined();
    expect(reviewer.edit!['*']).toBe('deny');
    expect(reviewer.bash!['*tossana-agents clickup subtask*']).toBe('deny');

    const tester = perm('tester');
    expect(tester.edit!['*.test.*']).toBe('allow');
    expect(tester.edit!['*\\__tests__\\*']).toBe('allow');
    expect(tester.bash!['pnpm install*']).toBeUndefined();
    expect(tester.bash!['git add -A*']).toBe('deny');
  });
});

describe('init interactive', () => {
  it('asks for the token (masked), the list and the owner, and saves the token only in .env', async () => {
    project = rnProject('');
    const asked: string[] = [];
    const prompts: Prompts = {
      select: async (message, choices, initial) => {
        asked.push(message);
        if (message.startsWith('Which ClickUp list')) return choices.find((c) => c.label.endsWith('/ Sprint'))!.value;
        return initial ?? choices[0]!.value;
      },
      confirm: async (message) => {
        asked.push(message);
        return true;
      },
      text: async (_m, initial) => initial ?? '',
      password: async (message) => {
        asked.push(message);
        return TOKEN;
      },
    };
    const fake = api()
      .on('GET /v2/team', { teams: [{ id: 'W9', name: 'Tossana' }] })
      .on('GET /v2/team/W9/space', { spaces: [{ id: 'S', name: 'Apps' }] })
      .on('GET /v2/space/S/folder', { folders: [{ id: 'F', name: 'Mobile', lists: [{ id: 'L1', name: 'Sprint' }] }] })
      .on('GET /v2/space/S/list', { lists: [] });
    let out = '';
    const { runCli } = await import('../program.js');
    const code = await runCli(['init', '--no-doctor'], {
      cwd: project.dir,
      processEnv: {},
      fetch: fake.fetch,
      prompts,
      now: () => new Date('2026-10-09T12:00:00Z'),
      io: { out: (t) => (out += t), err: (t) => (out += t), readStdin: async () => '', interactive: true },
    });
    expect(code).toBe(0);
    expect(asked).toEqual([
      expect.stringContaining('Project type (detected: react-native'),
      'Skill for the coder',
      'Use these commands?',
      'Does this project use Figma designs?',
      expect.stringContaining('Your ClickUp API token'),
      "Which ClickUp list holds this project's tasks?",
      expect.stringContaining('Status mapping: todo → "to do"'),
      'Send "ready for review" notifications to you (dara, id 777)?',
    ]);
    expect(read(project, '.env')).toBe(`CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\n`);
    expect(JSON.parse(read(project, 'agent.config.json')).clickup).toMatchObject({ listId: 'L1', workspaceId: 'W9' });
    expect(JSON.parse(read(project, 'agent.config.json')).figma).toEqual({ enabled: true });
    expect(existsSync(join(project.dir, 'opencode.json'))).toBe(true);
    expect(out).not.toContain(TOKEN);
    for (const file of Object.keys(snapshot(project.dir)).filter((f) => !f.endsWith('.env'))) {
      expect(readFileSync(join(project.dir, file), 'utf8')).not.toContain(TOKEN);
    }
  });
});

describe('helpers', () => {
  it('mapStatuses picks "ready for narak" for human and ignores closed statuses', () => {
    expect(mapStatuses(EKMONG_LIST.statuses).statuses).toEqual({
      todo: 'to do',
      coding: 'coding',
      review: 'in review',
      testing: 'testing',
      human: 'ready for narak',
    });
    const r = mapStatuses([
      { status: 'Open', type: 'open' },
      { status: 'In Progress', type: 'custom' },
      { status: 'QA', type: 'custom' },
      { status: 'Done', type: 'done' },
    ]);
    expect(r.statuses).toMatchObject({
      todo: 'Open',
      coding: 'In Progress',
      testing: 'QA',
      review: 'in review',
      human: 'ready for review',
    });
    expect(r.matched).toEqual(['todo', 'coding', 'testing']);
  });

  it('mapStatuses keeps an existing mapping when the list still has it', () => {
    const r = mapStatuses(LIST.statuses, { human: 'testing', testing: 'in review' });
    expect(r.statuses.human).toBe('testing');
  });

  it('setEnvValue replaces or adds one line and keeps the rest', () => {
    project = tempProject({ env: '# mine\r\nA=1\r\nCLICKUP_API_TOKEN=old\r\n' });
    setEnvValue(project.dir, 'CLICKUP_API_TOKEN', 'pk_new_value');
    setEnvValue(project.dir, 'CLICKUP_OWNER_USER_ID', '5');
    expect(read(project, '.env')).toBe('# mine\nA=1\nCLICKUP_API_TOKEN=pk_new_value\nCLICKUP_OWNER_USER_ID=5\n');
  });

  it('ensureGitignore keeps .env.example committable with an EKMONG-style .gitignore', () => {
    project = tempProject();
    project.write('.gitignore', 'node_modules/\r\n.env*\r\n!.env.example\r\n.agents/handoff/*\r\n.agents/logs/\r\n');
    ensureGitignore(project.dir);
    const added = read(project, '.gitignore').split('# Tossana agent kit')[1]!;
    expect(added).not.toContain('.env');
    expect(added).not.toContain('.agents/handoff/');
    expect(added).toContain('.agents/tmp/');
    // git itself agrees: .env ignored, .env.example not.
    const check = (f: string) => exec('git', ['check-ignore', '--no-index', '-q', f], { cwd: project.dir }).code;
    exec('git', ['init', '-q'], { cwd: project.dir });
    expect(check('.env')).toBe(0);
    expect(check('.env.example')).toBe(1);
    expect(check('.agents/tmp/x.md')).toBe(0);
  });

  it('ensureGitignore re-adds !.env.example after a new .env.* rule', () => {
    project = tempProject();
    project.write('.gitignore', '!.env.example\n');
    ensureGitignore(project.dir);
    const text = read(project, '.gitignore');
    expect(text.lastIndexOf('!.env.example')).toBeGreaterThan(text.indexOf('.env.*'));
    exec('git', ['init', '-q'], { cwd: project.dir });
    expect(exec('git', ['check-ignore', '--no-index', '-q', '.env.example'], { cwd: project.dir }).code).toBe(1);
  });

  it('ensureGitignore adds only missing lines, once', () => {
    project = tempProject();
    project.write('.gitignore', 'node_modules\r\n.env\r\n');
    expect(ensureGitignore(project.dir)).toBe(true);
    const once = read(project, '.gitignore');
    expect(once.match(/^\.env$/gm)).toHaveLength(1);
    expect(ensureGitignore(project.dir)).toBe(false);
    expect(read(project, '.gitignore')).toBe(once);
  });
});
