import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import {
  agentSkills,
  defaultAgentSkills,
  pipelineRoles,
  resolveSkill,
  roleSkillNames,
  usesDefaultRoles,
} from './roles.js';

const base = {
  version: 1,
  project: { name: 'app', type: 'react-native', skill: 'mobile-master' },
  clickup: { listId: 'L1' },
};

describe('pipeline roles', () => {
  it('defaults to coder → reviewer → tester (Figma only for coder and reviewer)', () => {
    const config = parseConfig({ ...base, figma: { enabled: true } });
    expect(usesDefaultRoles(config)).toBe(true);
    expect(pipelineRoles(config)).toEqual([
      {
        name: 'coder',
        purpose: '',
        preset: 'edit-code',
        skills: ['mobile-master'],
        mcp: ['figma'],
        status: 'coding',
        kind: 'code',
      },
      {
        name: 'reviewer',
        purpose: '',
        preset: 'read-only',
        skills: ['review-checklist', 'mobile-master'],
        mcp: ['figma'],
        status: 'review',
        kind: 'check',
      },
      {
        name: 'tester',
        purpose: '',
        preset: 'edit-tests-only',
        skills: ['testing-react-native'],
        mcp: [],
        status: 'testing',
        kind: 'check',
      },
    ]);
  });

  it('reads custom roles in order: planners before the first coder, checks after it', () => {
    const config = parseConfig({
      ...base,
      advanced: { customRoles: true },
      roles: [
        { name: 'manager', preset: 'read-only', purpose: 'Split the task into steps.' },
        { name: 'coder', preset: 'edit-code', skills: ['mobile-master', 'ekmong-i18n'] },
        { name: 'security-reviewer', preset: 'read-only', status: 'review', skills: [] },
        { name: 'tester', preset: 'edit-tests-only' },
      ],
    });
    const roles = pipelineRoles(config);
    expect(usesDefaultRoles(config)).toBe(false);
    expect(roles.map((r) => [r.name, r.kind, r.status])).toEqual([
      ['manager', 'plan', 'review'],
      ['coder', 'code', 'coding'],
      ['security-reviewer', 'check', 'review'],
      ['tester', 'check', 'testing'],
    ]);
    expect(roles[0]!.purpose).toBe('Split the task into steps.');
    expect(roleSkillNames(roles)).toEqual(['mobile-master', 'ekmong-i18n']);
  });

  it.each([
    [[{ name: 'orchestrator', preset: 'edit-code' }], '"orchestrator" is added by the kit'],
    [
      [
        { name: 'coder', preset: 'edit-code' },
        { name: 'coder', preset: 'read-only' },
      ],
      'listed twice',
    ],
    [[{ name: 'reviewer', preset: 'read-only' }], 'at least one role with preset "edit-code"'],
    [
      [
        { name: 'tester', preset: 'edit-tests-only' },
        { name: 'coder', preset: 'edit-code' },
      ],
      'must be "read-only"',
    ],
    [[{ name: 'coder', preset: 'edit-code', mcp: ['figma'] }], 'figma.enabled is false'],
    [[{ name: 'Coder', preset: 'edit-code' }], 'single hyphens'],
    [[{ name: 'coder', preset: 'edit-code', mcp: ['github'] }], 'roles.0.mcp.0'],
    [[{ name: 'coder', preset: 'admin' }], 'roles.0.preset'],
  ])('rejects invalid roles %#', (roles, message) => {
    expect(() => parseConfig({ ...base, advanced: { customRoles: true }, roles })).toThrow(message);
  });
});

describe('fixed pipeline and agent skills', () => {
  it('refuses custom roles unless advanced.customRoles is on, and names the fix', () => {
    const roles = [{ name: 'coder', preset: 'edit-code' }];
    expect(() => parseConfig({ ...base, roles })).toThrow(/advanced.*customRoles.*tossana-agents update/);
    expect(usesDefaultRoles(parseConfig({ ...base, advanced: { customRoles: true }, roles }))).toBe(false);
  });

  it('with custom roles, skills belong in roles[].skills, not in "agents"', () => {
    const roles = [{ name: 'coder', preset: 'edit-code' }];
    expect(() =>
      parseConfig({ ...base, advanced: { customRoles: true }, roles, agents: { coder: { skills: ['x'] } } }),
    ).toThrow('roles[].skills');
  });

  it.each([
    ['react-native', 'mobile-master', ['testing-react-native']],
    ['flutter', 'flutter-master', ['testing-flutter']],
    ['nextjs', 'frontend-master', ['testing-web']],
    ['react', 'frontend-master', ['testing-web']],
    ['node-backend', 'backend-master', ['testing-node']],
    ['other', 'backend-master', []],
  ])('defaults for %s', (type, skill, tester) => {
    const config = parseConfig({ ...base, project: { name: 'x', type, skill } });
    expect(defaultAgentSkills(config)).toEqual({ coder: [skill], reviewer: ['review-checklist', skill], tester });
    expect(agentSkills(config)).toEqual(defaultAgentSkills(config));
  });

  it('"agents" in agent.config.json replaces the defaults per role, and the pipeline uses them', () => {
    const config = parseConfig({
      ...base,
      agents: { coder: { skills: ['mobile-master', 'ekmong-i18n'] }, tester: { skills: [] } },
    });
    expect(agentSkills(config)).toEqual({
      coder: ['mobile-master', 'ekmong-i18n'],
      reviewer: ['review-checklist', 'mobile-master'],
      tester: [],
    });
    expect(pipelineRoles(config).map((r) => [r.name, r.skills])).toEqual([
      ['coder', ['mobile-master', 'ekmong-i18n']],
      ['reviewer', ['review-checklist', 'mobile-master']],
      ['tester', []],
    ]);
  });

  it('refuses unknown agents, unknown keys, bad or duplicate skill names', () => {
    expect(() => parseConfig({ ...base, agents: { planner: { skills: [] } } })).toThrow();
    expect(() => parseConfig({ ...base, agents: { coder: { skills: [], tools: [] } } })).toThrow();
    expect(() => parseConfig({ ...base, agents: { coder: { skills: ['../x'] } } })).toThrow('lower-case');
    expect(() => parseConfig({ ...base, agents: { coder: { skills: ['a', 'a'] } } })).toThrow('twice');
  });
});

describe('skill scopes', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const skill = (root: string, name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'SKILL.md'), `# ${name}\n`);
  };

  it('project wins over user, user over team; kit-written copies count as team', () => {
    dir = mkdtempSync(join(tmpdir(), 'tak-skills-'));
    const cwd = join(dir, 'project');
    const home = join(dir, 'home');
    const opts = { cwd, home, teamSkills: ['mobile-master', 'frontend-master'] };

    expect(resolveSkill('mobile-master', opts)).toEqual({
      name: 'mobile-master',
      scope: 'team',
      path: '.agents/skills/mobile-master/SKILL.md',
    });
    expect(resolveSkill('nope', opts)).toBeNull();

    skill(join(home, '.agents', 'skills'), 'mobile-master');
    expect(resolveSkill('mobile-master', opts)).toMatchObject({ scope: 'user' });
    expect(resolveSkill('mobile-master', opts)!.path).toMatch(/home\/\.agents\/skills\/mobile-master\/SKILL\.md$/);

    skill(join(cwd, '.agents', 'skills'), 'mobile-master');
    expect(resolveSkill('mobile-master', opts)).toMatchObject({ scope: 'project' });
    const kitOwned = new Set(['.agents/skills/mobile-master/SKILL.md']);
    expect(resolveSkill('mobile-master', { ...opts, kitOwned })).toMatchObject({ scope: 'user' });
  });
});
