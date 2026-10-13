/**
 * Skills per agent of the fixed pipeline (coder → reviewer → tester), kept in agent.config.json "agents".
 *
 * init writes the defaults for the project type; `agents skills <role> add|remove|reset` edits them; `update` gives a
 * role the kit's new defaults only while it still has the defaults the kit wrote last time (recorded in the kit
 * manifest), so project edits are never lost. `skills customize` turns a team skill into a project copy.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AGENT_ROLES,
  CONFIG_FILE,
  KitError,
  defaultAgentSkills,
  type AgentConfig,
  type AgentRole,
} from '@tossana/agents-core';
import type { CliContext } from './context.js';
import { projectPath, readManifest, writeManifest } from './kit-manifest.js';
import { listSkills, templatesDir } from './templates.js';

export type AgentSkills = Record<AgentRole, string[]>;
type RawConfig = Record<string, unknown> & {
  project?: { type?: string; skill?: string };
  agents?: Partial<Record<AgentRole, { skills?: string[] }>>;
  advanced?: { customRoles?: boolean };
  roles?: unknown;
};

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function readRawConfig(cwd: string): RawConfig {
  return JSON.parse(stripBom(readFileSync(join(cwd, CONFIG_FILE), 'utf8'))) as RawConfig;
}

export function writeRawConfig(cwd: string, raw: RawConfig): void {
  writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(raw, null, 2)}\n`);
}

export const usesCustomRoles = (raw: RawConfig) => Array.isArray(raw.roles) && raw.advanced?.customRoles === true;

/**
 * Configs from before the pipeline was locked may have "roles": they now need advanced.customRoles, which is added
 * here so they keep working. Returns a message when the file changed.
 */
export function migrateConfigFile(cwd: string): string | null {
  if (!existsSync(join(cwd, CONFIG_FILE))) return null;
  const raw = readRawConfig(cwd);
  if (!Array.isArray(raw.roles) || raw.advanced?.customRoles === true) return null;
  raw.advanced = { ...raw.advanced, customRoles: true };
  writeRawConfig(cwd, raw);
  return `${CONFIG_FILE}: your custom "roles" are kept: added "advanced": { "customRoles": true }`;
}

/** What older kit versions gave each role (before "agents" existed): the stack skill for coder and reviewer. */
const legacyDefaults = (projectSkill: string): AgentSkills => ({
  coder: [projectSkill],
  reviewer: [projectSkill],
  tester: [],
});

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export interface SkillChange {
  role: AgentRole;
  before: string[];
  after: string[];
  /** updated = was on the kit's defaults, now on the new ones; kept = edited in the project, left as it is. */
  action: 'updated' | 'kept';
  /** For "kept": the kit's current default, so people can compare. */
  newDefault?: string[];
}

/**
 * The "agents" section for the fixed pipeline. A role whose skills are still the defaults the kit wrote last time
 * (`recorded`; for older projects the implicit old defaults) gets the current defaults; an edited role is kept.
 * Custom-roles projects have no "agents" section.
 */
export function reconcileAgentSkills(
  raw: RawConfig,
  recorded: AgentSkills | null,
): { agents: AgentSkills | null; defaults: AgentSkills | null; changes: SkillChange[] } {
  if (usesCustomRoles(raw)) return { agents: null, defaults: null, changes: [] };
  const project = raw.project as AgentConfig['project'];
  const defaults = defaultAgentSkills({ project });
  const previous = recorded ?? legacyDefaults(project.skill);
  const agents = {} as AgentSkills;
  const changes: SkillChange[] = [];
  for (const role of AGENT_ROLES) {
    const current = raw.agents?.[role]?.skills ?? previous[role];
    if (sameSet(current, previous[role])) {
      agents[role] = defaults[role];
      if (!sameSet(current, defaults[role])) {
        changes.push({ role, before: current, after: defaults[role], action: 'updated' });
      }
    } else {
      agents[role] = current;
      if (!sameSet(previous[role], defaults[role])) {
        changes.push({ role, before: current, after: current, action: 'kept', newDefault: defaults[role] });
      }
    }
  }
  return { agents, defaults, changes };
}

export function printSkillChanges(ctx: CliContext, changes: SkillChange[]): void {
  if (!changes.length) return;
  ctx.logger.info('Agent skills (agent.config.json "agents"):');
  for (const c of changes) {
    if (c.action === 'updated') {
      const added = c.after.filter((s) => !c.before.includes(s)).map((s) => `+ ${s}`);
      const removed = c.before.filter((s) => !c.after.includes(s)).map((s) => `- ${s}`);
      ctx.logger.info(`  ${c.role.padEnd(8)} ${[...added, ...removed].join(', ')} (new defaults)`);
    } else {
      ctx.logger.info(
        `  ${c.role.padEnd(8)} kept your skills: ${c.after.join(', ') || '(none)'}; ` +
          `the default is now: ${c.newDefault!.join(', ') || '(none)'} (reset with: tossana-agents agents skills ${c.role} reset)`,
      );
    }
  }
}

/** Remembers the defaults the kit just wrote, so the next update can tell them from project edits. */
export function recordAgentDefaults(cwd: string, defaults: AgentSkills | null): void {
  const manifest = readManifest(cwd);
  if (!manifest) return;
  if (defaults) manifest.agentDefaults = defaults;
  else delete manifest.agentDefaults;
  writeManifest(cwd, manifest);
}

// ---------- team skills: customize / reset ----------

const MANAGED_LINE = /^(# |<!-- )Managed by @tossana\/agents v[^\n]*\n/m;

/**
 * Makes a team skill a project skill: .agents/skills/<skill>/ becomes the project's own (no managed header, not in
 * the kit manifest), so the project copy wins and `update` never overwrites it. Returns the folder.
 */
export function customizeSkill(cwd: string, skill: string): string {
  if (!listSkills().includes(skill)) {
    throw new KitError(`"${skill}" is not a team skill. Team skills: ${listSkills().join(', ')}`);
  }
  const folder = `.agents/skills/${skill}`;
  const manifest = readManifest(cwd);
  const owned = Object.keys(manifest?.files ?? {}).filter((f) => f.startsWith(`${folder}/`));
  const exists = existsSync(projectPath(cwd, `${folder}/SKILL.md`));
  if (exists && !owned.length) throw new KitError(`${folder} is already a project skill (yours to edit).`);
  if (!exists) cpSync(join(templatesDir(), 'skills', skill), projectPath(cwd, folder), { recursive: true });
  for (const file of owned) {
    const full = projectPath(cwd, file);
    if (existsSync(full) && file.endsWith('.md'))
      writeFileSync(full, readFileSync(full, 'utf8').replace(MANAGED_LINE, ''));
  }
  if (manifest) {
    manifest.files = Object.fromEntries(Object.entries(manifest.files).filter(([f]) => !owned.includes(f)));
    writeManifest(cwd, manifest);
  }
  return folder;
}

/** Back to the team version: the project copy is moved to a backup; `update` writes the team copy again. */
export function resetSkill(cwd: string, skill: string, now: Date): string {
  if (!listSkills().includes(skill))
    throw new KitError(`"${skill}" is not a team skill, so there is nothing to reset to.`);
  const folder = `.agents/skills/${skill}`;
  const manifest = readManifest(cwd);
  if (Object.keys(manifest?.files ?? {}).some((f) => f.startsWith(`${folder}/`))) {
    throw new KitError(`${folder} is already the team version.`);
  }
  if (!existsSync(projectPath(cwd, folder))) throw new KitError(`${folder} does not exist.`);
  const backup = `.agents/kit/backup/${now.toISOString().replace(/[:.]/g, '-')}/${folder}`;
  mkdirSync(dirname(projectPath(cwd, backup)), { recursive: true });
  cpSync(projectPath(cwd, folder), projectPath(cwd, backup), { recursive: true });
  rmSync(projectPath(cwd, folder), { recursive: true, force: true });
  return backup;
}
