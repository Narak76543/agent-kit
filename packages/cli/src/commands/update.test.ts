import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifest, sha256, writeManifest } from '../kit-manifest.js';
import type { Prompts } from '../prompts.js';
import { runCli } from '../program.js';
import { KIT_VERSION } from '../version.js';
import { LIST, TOKEN, cli, fakeApi, tempProject, type TempProject } from '../test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const read = (file: string) => readFileSync(join(project.dir, ...file.split('/')), 'utf8');

async function initialized() {
  project = tempProject({ config: null, env: `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=1\n` });
  project.write('package.json', { name: 'app', dependencies: { react: '19' }, scripts: { test: 'vitest' } });
  const api = fakeApi().on('GET /v2/list/L1', LIST);
  const r = await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api });
  expect(r.code).toBe(0);
}

/** Pretends the files were written by an older kit, so update has something to do. */
function ageKitFiles() {
  const manifest = readManifest(project.dir)!;
  const old = read('.opencode/agents/reviewer.md').replace('You are the **reviewer**', 'You were the reviewer');
  project.write('.opencode/agents/reviewer.md', old);
  manifest.files['.opencode/agents/reviewer.md'] = sha256(`${old.trimEnd()}\n`);
  writeManifest(project.dir, { ...manifest, kitVersion: '0.0.9' });
}

describe('update', () => {
  it('needs a config', async () => {
    project = tempProject({ config: null });
    expect((await cli(['update'], { cwd: project.dir })).err).toContain('Run: tossana-agents init');
  });

  it('reports nothing to do when everything is current', async () => {
    await initialized();
    const r = await cli(['update'], { cwd: project.dir });
    expect(r.out).toContain(`Kit files v${KIT_VERSION}:`);
    expect(r.out).toContain('12 file(s) already up to date');
  });

  it('updates files the person did not edit, and records the new version', async () => {
    await initialized();
    ageKitFiles();
    const r = await cli(['update'], { cwd: project.dir });
    expect(r.out).toContain(`Kit files v0.0.9 → v${KIT_VERSION}:`);
    expect(r.out).toMatch(/updated\s+\.opencode\/agents\/reviewer\.md/);
    expect(read('.opencode/agents/reviewer.md')).toContain('You are the **reviewer**');
    expect(readManifest(project.dir)!.kitVersion).toBe(KIT_VERSION);
  });

  it('never touches agent.config.json, .env or the AGENTS.md project section', async () => {
    await initialized();
    const config = read('agent.config.json');
    const env = read('.env');
    project.write('AGENTS.md', `${read('AGENTS.md')}\nMy rule.\n`);
    ageKitFiles();
    await cli(['update', '--force'], { cwd: project.dir });
    expect(read('agent.config.json')).toBe(config);
    expect(read('.env')).toBe(env);
    expect(read('AGENTS.md')).toContain('\nMy rule.\n');
  });

  it('keeps an edited file without a terminal, and asks (with a diff) in a terminal', async () => {
    await initialized();
    project.write('.opencode/agents/coder.md', `${read('.opencode/agents/coder.md')}\nLocal note.\n`);

    let r = await cli(['update'], { cwd: project.dir });
    expect(r.out).toMatch(/kept\s+\.opencode\/agents\/coder\.md/);
    expect(read('.opencode/agents/coder.md')).toContain('Local note.');

    const asked: string[] = [];
    const prompts: Prompts = {
      select: async (_m, c) => c[0]!.value,
      confirm: async (m) => {
        asked.push(m);
        return true;
      },
      text: async () => '',
      multiselect: async (_m, _c, initial) => initial,
      password: async () => '',
    };
    let out = '';
    const code = await runCli(['update'], {
      cwd: project.dir,
      processEnv: {},
      prompts,
      now: () => new Date('2026-10-09T12:00:00Z'),
      io: { out: (t) => (out += t), err: (t) => (out += t), readStdin: async () => '', interactive: true },
    });
    expect(code).toBe(0);
    expect(out).toContain('-Local note.');
    expect(asked).toEqual([
      '.opencode/agents/coder.md was edited locally. Replace it with the kit version (your changes are lost)?',
    ]);
    expect(read('.opencode/agents/coder.md')).not.toContain('Local note.');
    r = await cli(['update'], { cwd: project.dir });
    expect(r.out).toContain('12 file(s) already up to date');
  });

  it('removes kit files that are no longer needed when the skill changes', async () => {
    await initialized();
    const config = JSON.parse(read('agent.config.json'));
    config.project.skill = 'mobile-master';
    project.write('agent.config.json', config);
    const r = await cli(['update'], { cwd: project.dir });
    expect(r.out).toMatch(/created\s+\.agents\/skills\/mobile-master\/SKILL\.md/);
    expect(r.out).toMatch(/removed\s+\.agents\/skills\/frontend-master\/SKILL\.md/);
  });
});
