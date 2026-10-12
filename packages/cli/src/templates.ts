/**
 * Kit templates: locating them, rendering `{{placeholders}}`, adding the "Managed by" header,
 * and listing every kit-owned file for a project.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KitError,
  pipelineRoles,
  resolveSkill,
  roleSkillNames,
  type AgentConfig,
  type ResolvedSkill,
} from '@tossana/agents-core';
import { readManifest } from './kit-manifest.js';
import { pipelineVars, roleTemplate, roleVars } from './role-vars.js';
import { KIT_VERSION } from './version.js';

/** packages/cli/templates when installed (copied at build), packages/templates in the monorepo. */
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', 'templates'), join(here, '..', '..', 'templates')];
  const found = candidates.find((d) => existsSync(join(d, 'AGENTS.base.md')));
  if (!found) throw new KitError(`kit templates not found (looked in ${candidates.join(', ')})`);
  return found;
}

export const readTemplate = (name: string) => readFileSync(join(templatesDir(), ...name.split('/')), 'utf8');

const PLACEHOLDER = /\{\{([A-Za-z0-9_.]+)\}\}/g;

/**
 * Replaces `{{name}}`. A placeholder alone on its line with an empty value removes the line;
 * multi-line values must carry their own indentation. Unknown placeholders are an error.
 */
export function render(template: string, vars: Record<string, string>, source = 'template'): string {
  const unknown = new Set<string>();
  const out = template
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*\{\{([A-Za-z0-9_.]+)\}\}[ \t]*\n/gm, (line, key: string) => {
      if (!(key in vars)) return line; // reported below
      return vars[key] ? `${vars[key]!.replace(/\n$/, '')}\n` : '';
    })
    .replace(PLACEHOLDER, (match, key: string) => {
      if (!(key in vars)) {
        unknown.add(key);
        return match;
      }
      return vars[key]!;
    });
  if (unknown.size) throw new KitError(`${source}: unknown placeholder(s): ${[...unknown].join(', ')}`);
  return out;
}

export const MANAGED_TEXT = (version: string) =>
  `Managed by @tossana/agents v${version} — do not edit; run "tossana-agents update"`;

/**
 * Adds the managed header. Files with YAML frontmatter get a YAML comment on line 2 (frontmatter must
 * start on line 1); other Markdown gets an HTML comment on line 1.
 */
export function withManagedHeader(content: string, version = KIT_VERSION): string {
  if (content.startsWith('---\n')) return `---\n# ${MANAGED_TEXT(version)}\n${content.slice(4)}`;
  return `<!-- ${MANAGED_TEXT(version)} -->\n${content}`;
}

export interface KitFile {
  /** Project-relative POSIX path. */
  path: string;
  content: string;
}

export const AGENT_NAMES = ['orchestrator', 'coder', 'reviewer', 'tester'] as const;
export const PROJECT_MARKER = '<!-- PROJECT -->';

/**
 * Every kit-owned file for this config, rendered. AGENTS.md is only the part above the marker.
 * `skills` = how each skill name resolved (project / user / team); team skills are copied into the project.
 * Without it every skill is treated as a team skill (used by tests and the golden files).
 */
export function kitFiles(
  config: AgentConfig,
  vars: Record<string, string>,
  skills: Map<string, ResolvedSkill> = teamSkillMap(config),
): KitFile[] {
  const all = { ...vars, ...pipelineVars(config) };
  const roles = pipelineRoles(config);
  const files: KitFile[] = [];
  const add = (path: string, template: string, v: Record<string, string>) =>
    files.push({ path, content: withManagedHeader(render(readTemplate(template), v, template)) });

  add('.opencode/agents/orchestrator.md', 'opencode/agents/orchestrator.md', all);
  for (const role of roles) {
    add(`.opencode/agents/${role.name}.md`, `opencode/agents/${roleTemplate(role)}.md`, {
      ...all,
      ...roleVars(config, role, skills, all),
    });
  }
  files.push({
    path: 'AGENTS.md',
    content: withManagedHeader(render(readTemplate('AGENTS.base.md'), all, 'AGENTS.base.md')),
  });
  for (const name of ANTIGRAVITY_SKILLS) add(`.agents/${name}`, `antigravity/${name}`, all);
  for (const role of roles) {
    const wrapper = roleTemplate(role) === 'planner' ? 'reviewer' : roleTemplate(role);
    add(`.agents/agents/${role.name}.md`, `antigravity/agents/${wrapper}.md`, {
      ...all,
      ...roleVars(config, role, skills, all),
    });
  }
  for (const skill of skills.values()) if (skill.scope === 'team') files.push(...skillFiles(skill.name));
  return files;
}

/** Antigravity skills (`/start-task`, `/explore`), under `.agents/`. */
const ANTIGRAVITY_SKILLS = ['skills/start-task/SKILL.md', 'skills/explore/SKILL.md'];

/** Every role skill as a team skill (bundled with the kit). */
function teamSkillMap(config: AgentConfig): Map<string, ResolvedSkill> {
  return new Map(
    roleSkillNames(pipelineRoles(config)).map((name) => [
      name,
      { name, scope: 'team' as const, path: `.agents/skills/${name}/SKILL.md` },
    ]),
  );
}

/** A team skill, copied as-is (Antigravity and OpenCode both find `.agents/skills/`; Markdown gets the managed header). */
function skillFiles(skill: string): KitFile[] {
  const dir = join(templatesDir(), 'skills', skill);
  if (!existsSync(dir)) {
    throw new KitError(`unknown skill "${skill}". Available: ${listSkills().join(', ')}`);
  }
  return walk(dir).map((file) => {
    const rel = relative(dir, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    return {
      path: `.agents/skills/${skill}/${rel}`,
      content: file.endsWith('.md') ? withManagedHeader(text) : text,
    };
  });
}

export function listSkills(): string[] {
  const dir = join(templatesDir(), 'skills');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((d) => statSync(join(dir, d)).isDirectory())
        .sort()
    : [];
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

/**
 * How each role skill resolves in this project: project `.agents/skills/` (not written by the kit) wins,
 * then the developer's `~/.agents/skills/`, then the team skills bundled with the kit.
 */
export function resolveRoleSkills(cwd: string, config: AgentConfig, home?: string): Map<string, ResolvedSkill> {
  const kitOwned = new Set(Object.keys(readManifest(cwd)?.files ?? {}));
  const teamSkills = listSkills();
  const out = new Map<string, ResolvedSkill>();
  for (const name of roleSkillNames(pipelineRoles(config))) {
    const skill = resolveSkill(name, { cwd, teamSkills, kitOwned, home });
    if (!skill) {
      throw new KitError(
        `unknown skill "${name}". Add .agents/skills/${name}/SKILL.md (project) or ~/.agents/skills/${name}/SKILL.md ` +
          `(your machine), or use a team skill: ${teamSkills.join(', ')}`,
      );
    }
    out.set(name, skill);
  }
  return out;
}
