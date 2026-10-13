/**
 * Agent profiles on disk (plan Phase 9): team profiles in the project, personal ones in the home folder, and what a
 * run with a profile needs (its skills where every tool can read them, the roles that get them, MCP warnings).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KitError,
  PROFILE_SLUG,
  ProfileError,
  parseProfile,
  pipelineRoles,
  profileLabel,
  resolveSkill,
  userSkillsDir,
  type AgentConfig,
  type AgentProfile,
  type AgentProfileInput,
  type ProfileScope,
  type SkillScope,
} from '@tossana/agents-core';
import type { CliContext } from './context.js';
import { readManifest } from './kit-manifest.js';
import { TMP_DIR } from './presets.js';
import { listSkills, templatesDir } from './templates.js';

export const TEAM_PROFILES_DIR = join('.agents', 'profiles');
export const personalProfilesDir = (home: string) => join(home, '.agents', 'profiles');
/** Skills that are not in the project are copied here for a run (git-ignored, inside the workspace). */
export const RUN_SKILLS_DIR = `${TMP_DIR}/skills`;

export interface StoredProfile {
  slug: string;
  scope: ProfileScope;
  /** Absolute path of the JSON file. */
  file: string;
  /** Missing when the file is not a valid profile (see `error`). */
  profile?: AgentProfile;
  error?: string;
}

const dirFor = (ctx: CliContext, scope: ProfileScope) =>
  scope === 'team' ? join(ctx.cwd, TEAM_PROFILES_DIR) : personalProfilesDir(ctx.home);

function assertSlug(slug: string): void {
  if (!PROFILE_SLUG.test(slug) || slug.length > 40) {
    throw new KitError(
      `"${slug}" is not a valid agent id: use lower-case letters, digits and hyphens, e.g. rei-mobile`,
    );
  }
}

function readProfile(file: string, slug: string, scope: ProfileScope): StoredProfile {
  try {
    // A BOM (Notepad on Windows) would make JSON.parse fail.
    const text = readFileSync(file, 'utf8');
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    return { slug, scope, file, profile: parseProfile(raw, `${scope} agent "${slug}"`) };
  } catch (e) {
    return {
      slug,
      scope,
      file,
      error: e instanceof ProfileError ? e.message : `cannot read ${file}: ${(e as Error).message}`,
    };
  }
}

/** Team profiles first, then personal ones; each group sorted by name. Invalid files are listed with an error. */
export function listProfiles(ctx: CliContext): StoredProfile[] {
  const out: StoredProfile[] = [];
  for (const scope of ['team', 'personal'] as const) {
    const dir = dirFor(ctx, scope);
    if (!existsSync(dir)) continue;
    const found = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && PROFILE_SLUG.test(f.slice(0, -5)))
      .map((f) => readProfile(join(dir, f), f.slice(0, -5), scope));
    out.push(...found.sort((a, b) => (a.profile?.name ?? a.slug).localeCompare(b.profile?.name ?? b.slug)));
  }
  return out;
}

/** The profile with this id (team first, then personal). Throws with the fix when it is missing or invalid. */
export function findProfile(ctx: CliContext, slug: string): StoredProfile & { profile: AgentProfile } {
  assertSlug(slug);
  for (const scope of ['team', 'personal'] as const) {
    const file = join(dirFor(ctx, scope), `${slug}.json`);
    if (!existsSync(file)) continue;
    const found = readProfile(file, slug, scope);
    if (!found.profile) throw new KitError(found.error!);
    return found as StoredProfile & { profile: AgentProfile };
  }
  const known = listProfiles(ctx).map((p) => p.slug);
  throw new KitError(
    `no agent "${slug}". ${known.length ? `Agents: ${known.join(', ')}` : 'Create one with: tossana-agents agents create'}`,
  );
}

/** Writes a profile. Refuses an id that is used in the other scope, and an existing one unless `replace`. */
export function saveProfile(
  ctx: CliContext,
  input: { scope: ProfileScope; slug: string; profile: AgentProfileInput; replace?: boolean },
): StoredProfile & { profile: AgentProfile } {
  assertSlug(input.slug);
  const profile = parseProfile(input.profile, `agent "${input.slug}"`);
  const other = input.scope === 'team' ? 'personal' : 'team';
  if (existsSync(join(dirFor(ctx, other), `${input.slug}.json`))) {
    throw new KitError(`a ${other} agent "${input.slug}" already exists; choose another id`);
  }
  const dir = dirFor(ctx, input.scope);
  const file = join(dir, `${input.slug}.json`);
  if (existsSync(file) && !input.replace) throw new KitError(`agent "${input.slug}" already exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
  return { slug: input.slug, scope: input.scope, file, profile };
}

export function deleteProfile(ctx: CliContext, scope: ProfileScope, slug: string): string {
  assertSlug(slug);
  const file = join(dirFor(ctx, scope), `${slug}.json`);
  if (!existsSync(file)) throw new KitError(`no ${scope} agent "${slug}"`);
  rmSync(file);
  return file;
}

// ---------- skills ----------

export interface SkillInfo {
  name: string;
  scope: SkillScope;
  /** First paragraph-ish line of SKILL.md (description from the front matter when there is one). */
  description: string;
}

function skillDescription(file: string): string {
  try {
    const text = readFileSync(file, 'utf8');
    const front = /^---\r?\n[\s\S]*?^description:\s*(.+)$/m.exec(text);
    if (front) return front[1]!.trim().replace(/^["']|["']$/g, '');
    return (
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && !l.startsWith('---')) ?? ''
    );
  } catch {
    return '';
  }
}

const skillDirs = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
        .map((d) => d.name)
    : [];

/** Every skill a profile can use here: project, user (this machine) and team (bundled with the kit). */
export function availableSkills(ctx: CliContext): SkillInfo[] {
  const teamSkills = listSkills();
  const kitOwned = new Set(Object.keys(readManifest(ctx.cwd)?.files ?? {}));
  const names = new Set([
    ...skillDirs(join(ctx.cwd, '.agents', 'skills')),
    ...skillDirs(userSkillsDir(ctx.home)),
    ...teamSkills,
  ]);
  const out: SkillInfo[] = [];
  for (const name of names) {
    const s = resolveSkill(name, { cwd: ctx.cwd, teamSkills, kitOwned, home: ctx.home });
    if (!s) continue;
    const file =
      s.scope === 'user'
        ? join(userSkillsDir(ctx.home), name, 'SKILL.md')
        : s.scope === 'team'
          ? join(templatesDir(), 'skills', name, 'SKILL.md')
          : join(ctx.cwd, s.path);
    out.push({ name, scope: s.scope, description: skillDescription(file) });
  }
  const order: Record<SkillScope, number> = { project: 0, user: 1, team: 2 };
  return out.sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name));
}

const SKILL_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

${description}

## When to use

- <which tasks or files this skill is for>

## Rules

- <conventions the agent must follow: libraries, patterns, naming>
- <what to avoid>

## Examples

- <a short example or a link to a file in this project that shows the pattern>
`;

/** A new project skill from the template: .agents/skills/<name>/SKILL.md. Refuses to overwrite. */
export function createProjectSkill(ctx: CliContext, name: string, description: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    throw new KitError(`"${name}" is not a valid skill name: use lower-case letters, digits and hyphens`);
  }
  const text = description.replace(/\s+/g, ' ').trim();
  if (!text) throw new KitError('describe the skill in one line');
  const dir = join(ctx.cwd, '.agents', 'skills', name);
  const file = join(dir, 'SKILL.md');
  if (existsSync(file)) throw new KitError(`the project skill "${name}" already exists`);
  if (listSkills().includes(name)) throw new KitError(`"${name}" is a team skill; choose another name`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, SKILL_TEMPLATE(name, text));
  return `.agents/skills/${name}/SKILL.md`;
}

// ---------- a run with a profile ----------

export interface ProfileSkill {
  name: string;
  scope: SkillScope;
  /** Project-relative path the agents read during the run. */
  path: string;
  /** Absolute folder to copy into RUN_SKILLS_DIR before the run (skills that are not in the project). */
  copyFrom?: string;
}

export interface ProfileRun {
  slug: string;
  scope: ProfileScope;
  profile: AgentProfile;
  /** The runner actually used (the profile's tool, or the one chosen instead). */
  runner: string;
  /** "Rei – Mobile · Codex" */
  label: string;
  /** Roles that get the profile's skills: coding roles and read-only checks (default: coder, reviewer). */
  roles: string[];
  skills: ProfileSkill[];
  missingSkills: string[];
  /** MCP servers the profile wants that this project has not set up. */
  mcpWarnings: string[];
}

export function planProfileRun(ctx: CliContext, config: AgentConfig, slug: string, runner?: string): ProfileRun {
  const { scope, profile } = findProfile(ctx, slug);
  const used = runner ?? profile.tool;
  const teamSkills = listSkills();
  const kitOwned = new Set(Object.keys(readManifest(ctx.cwd)?.files ?? {}));
  const skills: ProfileSkill[] = [];
  const missingSkills: string[] = [];
  for (const name of profile.skills) {
    const s = resolveSkill(name, { cwd: ctx.cwd, teamSkills, kitOwned, home: ctx.home });
    if (!s) {
      missingSkills.push(name);
      continue;
    }
    const inProject = s.scope !== 'user' && existsSync(join(ctx.cwd, '.agents', 'skills', name, 'SKILL.md'));
    if (inProject) skills.push({ name, scope: s.scope, path: `.agents/skills/${name}/SKILL.md` });
    else
      skills.push({
        name,
        scope: s.scope,
        path: `${RUN_SKILLS_DIR}/${name}/SKILL.md`,
        copyFrom: s.scope === 'user' ? join(userSkillsDir(ctx.home), name) : join(templatesDir(), 'skills', name),
      });
  }
  const mcpWarnings = profile.mcp
    .filter((m) => m === 'figma' && !config.figma.enabled)
    .map((m) => `${m} is not set up in this project. Add it with: tossana-agents init --${m}`);
  return {
    slug,
    scope,
    profile,
    runner: used,
    label: profileLabel(profile.name, used),
    roles: pipelineRoles(config)
      .filter((r) => r.preset === 'edit-code' || (r.preset === 'read-only' && r.kind === 'check'))
      .map((r) => r.name),
    skills,
    missingSkills,
    mcpWarnings,
  };
}

/** Throws when the run cannot use the profile as it is (missing skills). */
export function assertProfileRunnable(plan: ProfileRun): void {
  if (plan.missingSkills.length) {
    throw new KitError(
      `agent "${plan.slug}" uses skills that are not available here: ${plan.missingSkills.join(', ')}. ` +
        'Add them to .agents/skills/ (project) or ~/.agents/skills/ (this machine), or edit the agent.',
    );
  }
}

/** Copies the skills that are not in the project to RUN_SKILLS_DIR, so every tool (and sandbox) can read them. */
export function stageProfileSkills(ctx: CliContext, plan: ProfileRun): void {
  for (const s of plan.skills) {
    if (!s.copyFrom) continue;
    const to = join(ctx.cwd, ...RUN_SKILLS_DIR.split('/'), s.name);
    rmSync(to, { recursive: true, force: true });
    cpSync(s.copyFrom, to, { recursive: true });
  }
}

/** The body of the handoff entry: what the coding and review roles read before they start. */
export function profileHandoffText(plan: ProfileRun): string[] {
  const who = plan.roles.map((r) => `\`${r}\``).join(' and ');
  return [
    `Agent profile: ${plan.profile.name} (${plan.scope} agent "${plan.slug}"), tool ${plan.label.split(' · ').at(-1)}.`,
    plan.skills.length
      ? `Skills for the ${who} (read them before you start, in addition to your own skill):\n${plan.skills
          .map((s) => `- ${s.name}: \`${s.path}\``)
          .join('\n')}`
      : 'No extra skills.',
    ...(plan.profile.mcp.length ? [`MCP servers for this agent: ${plan.profile.mcp.join(', ')}.`] : []),
    'This applies until the next "Run started" or "Resumed" entry. Role permissions and locked rules do not change.',
  ];
}
