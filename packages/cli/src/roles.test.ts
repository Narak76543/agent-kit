import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifest } from './kit-manifest.js';
import { LIST, TOKEN, cli, fakeApi, tempProject, type TempProject } from './test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const api = () =>
  fakeApi()
    .on('GET /v2/user', { user: { id: 777, username: 'dara' } })
    .on('GET /v2/list/L1', LIST);
const read = (file: string) => readFileSync(join(project.dir, ...file.split('/')), 'utf8');
const init = () => cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });

function rnProject(config?: object) {
  const p = tempProject({ config: null, env: `CLICKUP_API_TOKEN=${TOKEN}\n` });
  p.write('package.json', { name: 'app', dependencies: { 'react-native': '0.86.0' } });
  if (config) p.write('agent.config.json', config);
  return p;
}

describe('init with custom roles and skill scopes', () => {
  it('keeps "roles" from agent.config.json and writes one agent per role for OpenCode and Antigravity', async () => {
    project = rnProject({
      version: 1,
      project: { name: 'app', type: 'react-native', skill: 'mobile-master' },
      clickup: { listId: 'L1' },
      roles: [
        { name: 'manager', preset: 'read-only' },
        { name: 'coder', preset: 'edit-code' },
        { name: 'qa', preset: 'edit-tests-only' },
      ],
    });
    const r = await init();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(read('agent.config.json')).roles).toHaveLength(3);
    for (const name of ['orchestrator', 'manager', 'coder', 'qa']) {
      expect(existsSync(join(project.dir, '.opencode', 'agents', `${name}.md`))).toBe(true);
    }
    expect(existsSync(join(project.dir, '.opencode', 'agents', 'reviewer.md'))).toBe(false);
    expect(read('.agents/agents/qa.md')).toContain('name: qa');
    expect(read('.opencode/agents/orchestrator.md')).toContain('Invoke `manager` with task ID');
    expect(read('.opencode/agents/qa.md')).toContain('[AGENT: qa] [RESULT: PASS | FAIL]');
  });

  it('a project skill wins: the kit does not copy the team skill and points the agents at the project one', async () => {
    project = rnProject();
    project.write('.agents/skills/mobile-master/SKILL.md', '---\nname: mobile-master\n---\n# Our own rules\n');
    const r = await init();
    expect(r.code).toBe(0);
    expect(read('.agents/skills/mobile-master/SKILL.md')).toContain('# Our own rules');
    expect(Object.keys(readManifest(project.dir)!.files)).not.toContain('.agents/skills/mobile-master/SKILL.md');
    expect(read('.opencode/agents/coder.md')).toContain('`.agents/skills/mobile-master/SKILL.md`');
  });

  it('a kit-written team skill stays kit-owned on the next run (not mistaken for a project skill)', async () => {
    project = rnProject();
    await init();
    expect(Object.keys(readManifest(project.dir)!.files)).toContain('.agents/skills/mobile-master/SKILL.md');
    const r = await init();
    expect(r.out).toContain('already up to date');
    expect(Object.keys(readManifest(project.dir)!.files)).toContain('.agents/skills/mobile-master/SKILL.md');
  });

  it('refuses an unknown skill with the three places it may live', async () => {
    project = rnProject({
      version: 1,
      project: { name: 'app', type: 'react-native', skill: 'mobile-master' },
      clickup: { listId: 'L1' },
      roles: [{ name: 'coder', preset: 'edit-code', skills: ['no-such-skill'] }],
    });
    const r = await init();
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown skill "no-such-skill". Add .agents/skills/no-such-skill/SKILL.md (project)');
  });
});
