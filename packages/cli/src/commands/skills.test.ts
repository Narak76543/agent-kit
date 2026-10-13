import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readManifest, writeManifest } from '../kit-manifest.js';
import { CONFIG, cli, fakeApi, fakeExec, tempProject, type TempProject } from '../test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const LIST = {
  id: 'L1',
  name: 'Mobile',
  statuses: ['to do', 'coding', 'in review', 'testing', 'ready for review'].map((status) => ({
    status,
    type: 'custom',
  })),
};
const read = (f: string) => readFileSync(join(project.dir, ...f.split('/')), 'utf8');
const config = () =>
  JSON.parse(read('agent.config.json')) as Record<string, unknown> & { agents: Record<string, { skills: string[] }> };
const run = (args: string[]) =>
  cli(args, { cwd: project.dir, exec: fakeExec(), api: fakeApi().on('GET /v2/list/L1', LIST) });

async function initProject(extra: object = {}) {
  project = tempProject({ config: { ...CONFIG, ...extra } });
  const r = await run(['init', '--yes', '--no-doctor']);
  expect(r.code, r.err).toBe(0);
}

describe('agents skills', () => {
  it('init writes the default agents for the project type', async () => {
    await initProject();
    expect(config().agents).toEqual({
      coder: { skills: ['mobile-master'] },
      reviewer: { skills: ['review-checklist', 'mobile-master'] },
      tester: { skills: ['testing-react-native'] },
    });
    expect(read('.agents/skills/testing-react-native/SKILL.md')).toContain('name: testing-react-native');
    expect(readManifest(project.dir)?.agentDefaults?.tester).toEqual(['testing-react-native']);
  });

  it('shows, adds, removes and resets skills per agent, and refreshes the agent files at once', async () => {
    await initProject();
    project.write(
      '.agents/skills/ekmong-i18n/SKILL.md',
      '---\nname: ekmong-i18n\ndescription: en/km keys\n---\n# i18n\n',
    );

    const show = await run(['agents', 'skills']);
    expect(show.out).toContain('reviewer review-checklist (team), mobile-master (team)');

    const add = await run(['agents', 'skills', 'coder', 'add', 'ekmong-i18n']);
    expect(add.code, add.err).toBe(0);
    expect(config().agents.coder).toEqual({ skills: ['mobile-master', 'ekmong-i18n'] });
    expect(read('.opencode/agents/coder.md')).toContain('`.agents/skills/ekmong-i18n/SKILL.md`');
    expect((await run(['agents', 'skills', 'coder'])).out).toContain('[default: mobile-master]');

    const remove = await run(['agents', 'skills', 'reviewer', 'remove', 'mobile-master']);
    expect(remove.code, remove.err).toBe(0);
    expect(config().agents.reviewer).toEqual({ skills: ['review-checklist'] });

    const reset = await run(['agents', 'skills', 'reviewer', 'reset']);
    expect(reset.code, reset.err).toBe(0);
    expect(config().agents.reviewer).toEqual({ skills: ['review-checklist', 'mobile-master'] });
  });

  it('refuses unknown skills, roles, actions and duplicates with the fix', async () => {
    await initProject();
    expect((await run(['agents', 'skills', 'coder', 'add', 'nope'])).err).toContain('no skill "nope". Available:');
    expect((await run(['agents', 'skills', 'planner'])).err).toContain('Agents: coder, reviewer, tester');
    expect((await run(['agents', 'skills', 'coder', 'swap', 'x'])).err).toContain(
      'Use: add <skill>, remove <skill> or reset',
    );
    expect((await run(['agents', 'skills', 'coder', 'add', 'mobile-master'])).err).toContain('already has');
    expect((await run(['agents', 'skills', 'tester', 'remove', 'mobile-master'])).err).toContain('does not have');
    expect(config().agents.coder).toEqual({ skills: ['mobile-master'] });
  });

  it('is refused for custom-roles projects (they keep roles[].skills)', async () => {
    await initProject({ advanced: { customRoles: true }, roles: [{ name: 'coder', preset: 'edit-code' }] });
    expect((await run(['agents', 'skills'])).err).toContain('edit roles[].skills');
    expect(config().agents).toBeUndefined();
  });
});

describe('skills customize / reset', () => {
  it('customize makes the team copy the project own; update keeps it; reset restores the team version', async () => {
    await initProject();
    const r = await run(['skills', 'customize', 'review-checklist']);
    expect(r.code, r.err).toBe(0);
    const file = '.agents/skills/review-checklist/SKILL.md';
    expect(read(file)).not.toContain('Managed by @tossana/agents');
    expect(Object.keys(readManifest(project.dir)!.files)).not.toContain(file);

    project.write(file, `${read(file)}\n- Check that Khmer strings exist for every new key.\n`);
    const u = await run(['update']);
    expect(u.code, u.err).toBe(0);
    expect(read(file)).toContain('Khmer strings');
    expect(read('.opencode/agents/reviewer.md')).toContain('`.agents/skills/review-checklist/SKILL.md`');
    expect((await run(['skills', 'customize', 'review-checklist'])).err).toContain('already a project skill');

    const back = await run(['skills', 'reset', 'review-checklist']);
    expect(back.code, back.err).toBe(0);
    expect(read(file)).toContain('Managed by @tossana/agents');
    expect(read(file)).not.toContain('Khmer strings');
    const backups = readdirSync(join(project.dir, '.agents/kit/backup'));
    expect(readFileSync(join(project.dir, '.agents/kit/backup', backups[0]!, file), 'utf8')).toContain('Khmer strings');
  });

  it('customize copies a team skill no agent uses yet, and refuses non-team skills', async () => {
    await initProject();
    const r = await run(['skills', 'customize', 'testing-web']);
    expect(r.code, r.err).toBe(0);
    expect(read('.agents/skills/testing-web/SKILL.md')).toContain('name: testing-web');
    expect((await run(['skills', 'customize', 'my-own'])).err).toContain('not a team skill');
    expect((await run(['skills', 'reset', 'mobile-master'])).err).toContain('already the team version');
  });

  it('skills list shows scope and which agent uses each skill', async () => {
    await initProject();
    const r = await run(['skills']);
    expect(r.out).toMatch(/review-checklist +team +used by reviewer/);
    expect(r.out).toMatch(/mobile-master +team +used by coder, reviewer/);
    expect(r.out).toMatch(/testing-web +team\s*\n/);
  });
});

describe('update and the default agents', () => {
  it('untouched roles get new defaults, edited roles are kept, and it says so', async () => {
    await initProject();
    // Pretend an older kit wrote other defaults: the tester's were [] and the reviewer was edited since.
    const m = readManifest(project.dir)!;
    m.agentDefaults = { coder: ['mobile-master'], reviewer: ['mobile-master'], tester: [] };
    writeManifest(project.dir, m);
    const c = config();
    c.agents = {
      coder: { skills: ['mobile-master'] },
      reviewer: { skills: ['mobile-master', 'my-checks'] },
      tester: { skills: [] },
    };
    project.write('agent.config.json', c);
    project.write('.agents/skills/my-checks/SKILL.md', '---\nname: my-checks\n---\n');

    const r = await run(['update']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('tester   + testing-react-native (new defaults)');
    expect(r.out).toContain(
      'reviewer kept your skills: mobile-master, my-checks; the default is now: review-checklist, mobile-master',
    );
    expect(config().agents).toEqual({
      coder: { skills: ['mobile-master'] },
      reviewer: { skills: ['mobile-master', 'my-checks'] },
      tester: { skills: ['testing-react-native'] },
    });
    expect(readManifest(project.dir)?.agentDefaults?.tester).toEqual(['testing-react-native']);
    // Nothing to report the second time.
    expect((await run(['update'])).out).not.toContain('Agent skills');
  });

  it('a project from before "agents" gets them; an old custom-roles project gets the advanced flag', async () => {
    await initProject();
    const { agents: _dropped, ...c } = config();
    project.write('agent.config.json', c);
    const m = readManifest(project.dir)!;
    delete m.agentDefaults;
    writeManifest(project.dir, m);
    const r = await run(['update']);
    expect(r.code, r.err).toBe(0);
    expect(config().agents.tester).toEqual({ skills: ['testing-react-native'] });

    const { agents: _alsoDropped, ...old } = config();
    project.write('agent.config.json', { ...old, roles: [{ name: 'coder', preset: 'edit-code' }] });
    const doctor = await cli(['doctor'], { cwd: project.dir, exec: fakeExec(), api: fakeApi() });
    expect(doctor.out).toContain('"advanced": { "customRoles": true }');
    const u = await run(['update']);
    expect(u.code, u.err).toBe(0);
    expect(u.out).toContain('your custom "roles" are kept: added "advanced": { "customRoles": true }');
    expect(config().advanced).toEqual({ customRoles: true });
    expect(existsSync(join(project.dir, '.opencode/agents/reviewer.md'))).toBe(false);
  });
});
