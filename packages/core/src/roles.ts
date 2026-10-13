/**
 * Pipeline roles (plan Phase 7): `roles` in agent.config.json, or the default coder → reviewer → tester.
 * The orchestrator is not a role here: it is always added and runs these roles in order.
 */
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, AgentRole, ProjectType, RolePreset } from './config.js';

/** Team skill every reviewer reads (general review checklist). */
export const REVIEW_SKILL = 'review-checklist';

/** Team testing skill for the tester, per project type. */
export const TESTING_SKILL: Partial<Record<ProjectType, string>> = {
  'react-native': 'testing-react-native',
  flutter: 'testing-flutter',
  nextjs: 'testing-web',
  react: 'testing-web',
  'node-backend': 'testing-node',
};

/**
 * The default skills of each agent: the stack skill (project.skill, e.g. mobile-master) for the coder and the
 * reviewer, the review checklist for the reviewer, the stack's testing skill for the tester.
 */
export function defaultAgentSkills(config: Pick<AgentConfig, 'project'>): Record<AgentRole, string[]> {
  const testing = TESTING_SKILL[config.project.type];
  return {
    coder: [config.project.skill],
    reviewer: [REVIEW_SKILL, config.project.skill],
    tester: testing ? [testing] : [],
  };
}

/** The skills each agent uses: agent.config.json "agents", else the defaults. */
export function agentSkills(config: AgentConfig): Record<AgentRole, string[]> {
  const d = defaultAgentSkills(config);
  return {
    coder: config.agents?.coder?.skills ?? d.coder,
    reviewer: config.agents?.reviewer?.skills ?? d.reviewer,
    tester: config.agents?.tester?.skills ?? d.tester,
  };
}

export type RoleKind = 'plan' | 'code' | 'check';

export interface PipelineRole {
  name: string;
  /** Empty when the role uses the preset's standard text. */
  purpose: string;
  preset: RolePreset;
  skills: string[];
  mcp: string[];
  /** Status key (coding / review / testing) the orchestrator sets while this role works. */
  status: 'coding' | 'review' | 'testing';
  /**
   * plan  = read-only role before the first coding role (result PLANNED, never sends work back);
   * code  = edit-code role (result DONE_CODING);
   * check = a later role whose CHANGES_NEEDED / FAIL sends the work back to the first coding role.
   */
  kind: RoleKind;
}

const STATUS_FOR_PRESET: Record<RolePreset, PipelineRole['status']> = {
  'read-only': 'review',
  'edit-code': 'coding',
  'edit-tests-only': 'testing',
};

/** True unless custom roles are switched on (advanced): the fixed coder → reviewer → tester pipeline. */
export const usesDefaultRoles = (config: AgentConfig) => !(config.advanced.customRoles && config.roles);

export function pipelineRoles(config: AgentConfig): PipelineRole[] {
  const figma = config.figma.enabled ? ['figma'] : [];
  const skills = agentSkills(config);
  // The pipeline is fixed; custom roles only with advanced.customRoles (the schema refuses them otherwise).
  const roles = (!usesDefaultRoles(config) && config.roles) || [
    { name: 'coder', preset: 'edit-code' as const, skills: skills.coder, mcp: figma },
    { name: 'reviewer', preset: 'read-only' as const, skills: skills.reviewer, mcp: figma },
    { name: 'tester', preset: 'edit-tests-only' as const, skills: skills.tester, mcp: [] as string[] },
  ];
  const firstCoder = roles.findIndex((r) => r.preset === 'edit-code');
  return roles.map((r, i) => ({
    name: r.name,
    purpose: 'purpose' in r && r.purpose ? r.purpose : '',
    preset: r.preset,
    skills: 'skills' in r && r.skills ? r.skills : [config.project.skill],
    mcp: [...r.mcp],
    status: ('status' in r && r.status) || STATUS_FOR_PRESET[r.preset],
    kind: i < firstCoder ? 'plan' : r.preset === 'edit-code' ? 'code' : 'check',
  }));
}

/** Every skill name any role uses, in first-use order. */
export const roleSkillNames = (roles: PipelineRole[]) => [...new Set(roles.flatMap((r) => r.skills))];

// ---------- skill scopes ----------

export type SkillScope = 'project' | 'user' | 'team';

export interface ResolvedSkill {
  name: string;
  scope: SkillScope;
  /** Path the agents read: project-relative for project/team skills, absolute for user skills. */
  path: string;
}

export const PROJECT_SKILLS_DIR = '.agents/skills';
/** User-global skills on each developer's machine (never uploaded, never copied into the project). */
export const userSkillsDir = (home = homedir()) => join(home, '.agents', 'skills');

/**
 * Resolves a skill by scope: project wins, then user, then team (bundled with the kit).
 * `kitOwned` = project paths the kit wrote (from the manifest): those are team copies, not project skills.
 */
export function resolveSkill(
  name: string,
  options: { cwd: string; teamSkills: string[]; kitOwned?: Set<string>; home?: string },
): ResolvedSkill | null {
  const projectFile = `${PROJECT_SKILLS_DIR}/${name}/SKILL.md`;
  if (existsSync(join(options.cwd, projectFile)) && !options.kitOwned?.has(projectFile)) {
    return { name, scope: 'project', path: projectFile };
  }
  const userFile = join(userSkillsDir(options.home), name, 'SKILL.md');
  if (existsSync(userFile)) return { name, scope: 'user', path: userFile.split('\\').join('/') };
  if (options.teamSkills.includes(name)) return { name, scope: 'team', path: projectFile };
  return null;
}
