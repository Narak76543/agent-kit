/**
 * Kit templates: locating them, rendering `{{placeholders}}`, adding the "Managed by" header,
 * and listing every kit-owned file for a project.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KitError, type AgentConfig } from '@tossana/agents-core';
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

/** Every kit-owned file for this config, rendered. AGENTS.md is only the part above the marker. */
export function kitFiles(config: AgentConfig, vars: Record<string, string>): KitFile[] {
  const files: KitFile[] = [];
  for (const agent of AGENT_NAMES) {
    const name = `opencode/agents/${agent}.md`;
    files.push({
      path: `.opencode/agents/${agent}.md`,
      content: withManagedHeader(render(readTemplate(name), vars, name)),
    });
  }
  files.push({
    path: 'AGENTS.md',
    content: withManagedHeader(render(readTemplate('AGENTS.base.md'), vars, 'AGENTS.base.md')),
  });
  for (const name of ANTIGRAVITY_FILES) {
    const template = `antigravity/${name}`;
    files.push({
      path: `.agents/${name}`,
      content: withManagedHeader(render(readTemplate(template), vars, template)),
    });
  }
  files.push(...skillFiles(config.project.skill));
  return files;
}

/** Antigravity skills (`/start-task`, `/explore`) and subagent wrappers, under `.agents/`. */
const ANTIGRAVITY_FILES = [
  'skills/start-task/SKILL.md',
  'skills/explore/SKILL.md',
  ...AGENT_NAMES.filter((a) => a !== 'orchestrator').map((a) => `agents/${a}.md`),
];

/** The selected skill (Antigravity and OpenCode both find `.agents/skills/`), copied as-is (Markdown files get the managed header). */
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
