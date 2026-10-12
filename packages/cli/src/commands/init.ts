/**
 * `tossana-agents init`: sets up the kit in a project. Interactive by default; `--yes` uses detected
 * values and existing config. Running it again changes nothing that is already right.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import {
  AGENT_TOOLS,
  CONFIG_FILE,
  DEFAULT_STATUSES,
  ENV_FILE,
  KitError,
  PROJECT_TYPES,
  ROLES,
  SKILL_FOR_TYPE,
  detectProject,
  resolveSkill,
  isClosedType,
  loadConfig,
  loadEnv,
  parseConfig,
  parseDotEnv,
  type AgentConfig,
  type ClickUpClient,
  type ClickUpStatus,
  type AgentTool,
  type ProjectType,
  type Role,
} from '@tossana/agents-core';
import { wrongAccountHint } from '../account-hint.js';
import { applyClaudeSettings } from '../claude.js';
import { applyFigmaMcp, printFigmaResults, printMergeResults } from '../figma.js';
import { createClient, type CliContext } from '../context.js';
import { applyKitFiles, findMarker, printKitFileResults } from '../kit-files.js';
import { clackPrompts, type Prompts } from '../prompts.js';
import { templateVars } from '../template-vars.js';
import { kitFiles, resolveRoleSkills, listSkills, readTemplate, render } from '../templates.js';
import { printChecks, runDoctor } from './doctor.js';

export interface InitOptions {
  yes?: boolean;
  list?: string;
  type?: string;
  skill?: string;
  force?: boolean;
  doctor?: boolean;
  figma?: boolean;
  tools?: string;
}

const DEFAULT_TOOLS: AgentTool[] = ['opencode', 'antigravity'];
const TOOL_LABELS: Record<AgentTool, string> = {
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  'claude-code': 'Claude Code',
};

function parseTools(list: string): AgentTool[] {
  const tools = list
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const bad = tools.filter((t) => !(AGENT_TOOLS as readonly string[]).includes(t));
  if (bad.length || !tools.length) {
    throw new KitError(`unknown tool(s) ${bad.join(', ') || '(none)'}. Use: ${AGENT_TOOLS.join(', ')}`);
  }
  return [...new Set(tools)] as AgentTool[];
}

/** Project types without a UI: Figma support is off unless asked for. */
const NO_UI_TYPES: ProjectType[] = ['node-backend', 'other'];

export const SCHEMA_PATH = './node_modules/@tossana/agents/schema/agent.config.schema.json';

export const GITIGNORE_LINES = [
  '.env',
  '.env.*',
  '!.env.example',
  '.agents/handoff/',
  '.agents/logs/',
  '.agents/tmp/',
  '.agents/kit/backup/',
];
const GITIGNORE_HEADER = '# Tossana agent kit (tokens and local agent files)';

export function registerInitCommand(program: Command, ctx: CliContext, prompts: Prompts = clackPrompts): void {
  program
    .command('init')
    .description('set up the agent kit in this project (safe to run again)')
    .option('-y, --yes', 'no questions: use detected values and the existing config')
    .option('--list <listId>', 'ClickUp list ID (skips the list picker)')
    .option('--type <type>', `project type (${PROJECT_TYPES.join(', ')})`)
    .option('--skill <skill>', 'skill for the coder (e.g. mobile-master)')
    .option('--force', 'replace kit files you edited locally (a backup is kept)')
    .option('--no-doctor', 'do not run doctor at the end')
    .option('--figma', 'agents read Figma designs linked in tasks (Figma MCP server, read only)')
    .option('--no-figma', 'no Figma support')
    .option('--tools <list>', `agent tools to generate files for, comma-separated (${AGENT_TOOLS.join(', ')})`)
    .action(async (opts: InitOptions) => {
      if (!opts.yes && !ctx.io.interactive) {
        throw new KitError('init needs answers: run it in a terminal, or pass --yes (and --list <listId>)');
      }
      await runInit(ctx, opts, opts.yes ? null : prompts);
    });
}

export async function runInit(ctx: CliContext, opts: InitOptions, prompts: Prompts | null): Promise<void> {
  const log = (s: string) => ctx.logger.info(s);
  log(`Setting up the Tossana agent kit in ${ctx.cwd}\n`);

  // 1. git
  if (ctx.exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ctx.cwd }).code !== 0) {
    ctx.logger.warn('WARNING: this folder is not a git repository. The pipeline needs git: run "git init".');
  }

  // 2. existing config + detection
  const configFile = join(ctx.cwd, CONFIG_FILE);
  const existing: AgentConfig | null = existsSync(configFile) ? loadConfig(ctx.cwd) : null;
  const rawExisting = existing
    ? (JSON.parse(stripBom(readFileSync(configFile, 'utf8'))) as Record<string, unknown>)
    : {};
  const detected = detectProject(ctx.cwd);

  let type = (opts.type ?? existing?.project.type ?? detected.type) as ProjectType;
  if (!PROJECT_TYPES.includes(type))
    throw new KitError(`unknown project type "${type}". Use one of: ${PROJECT_TYPES.join(', ')}`);
  if (prompts && !opts.type) {
    type = await prompts.select(
      `Project type (detected: ${detected.type}, ${detected.reason})`,
      PROJECT_TYPES.map((t) => ({ value: t, label: t })),
      type,
    );
  }

  const skills = listSkills();
  let skill = opts.skill ?? existing?.project.skill ?? SKILL_FOR_TYPE[type];
  if (prompts && !opts.skill) {
    skill = await prompts.select(
      'Skill for the coder',
      skills.map((s) => ({ value: s, label: s })),
      skill,
    );
  }
  // A project or user skill with this name is fine too (resolveRoleSkills checks every role's skills later).
  if (!skills.includes(skill) && !resolveSkill(skill, { cwd: ctx.cwd, teamSkills: skills })) {
    throw new KitError(`unknown skill "${skill}". Available: ${skills.join(', ')}`);
  }

  let commands = existing?.commands ?? detected.commands;
  if (prompts) {
    log(formatCommands(commands));
    if (!(await prompts.confirm('Use these commands?', true))) {
      const ask = async (key: keyof typeof commands) =>
        (await prompts.text(`${key} command (empty = none)`, commands[key] ?? '')).trim() || undefined;
      commands = {
        install: await ask('install'),
        lint: await ask('lint'),
        typecheck: await ask('typecheck'),
        test: await ask('test'),
      };
    }
  }

  // Figma: default yes for UI projects, no for backends; --yes keeps the existing setting.
  let figma = opts.figma ?? existing?.figma.enabled ?? (prompts ? !NO_UI_TYPES.includes(type) : false);
  if (prompts && opts.figma === undefined) {
    figma = await prompts.confirm('Does this project use Figma designs?', figma);
  }

  // Agent tools: files are generated for each one (several allowed).
  let tools = opts.tools ? parseTools(opts.tools) : (existing?.tools ?? [...DEFAULT_TOOLS]);
  if (prompts && !opts.tools) {
    tools = await prompts.multiselect(
      'Which agent tools does the team use? (files are generated for each)',
      AGENT_TOOLS.map((t) => ({ value: t, label: TOOL_LABELS[t] })),
      tools,
    );
  }

  // 3. token
  let env = loadEnv(ctx.cwd, ctx.processEnv);
  if (!env.CLICKUP_API_TOKEN && prompts) {
    const token = (await prompts.password('Your ClickUp API token (ClickUp → Settings → Apps → API Token)')).trim();
    if (token) {
      setEnvValue(ctx.cwd, 'CLICKUP_API_TOKEN', token);
      env = loadEnv(ctx.cwd, ctx.processEnv);
      log('Saved the token to .env (nowhere else).');
    }
  }
  ctx.logger.addSecret(env.CLICKUP_API_TOKEN);
  const client = env.CLICKUP_API_TOKEN ? createClient(ctx, { config: null, env }) : null;

  // 4. list
  let listId = opts.list ?? existing?.clickup.listId;
  let workspaceId = existing?.clickup.workspaceId;
  if (!opts.list && prompts && client) {
    const picked = await pickList(client, prompts, listId);
    listId = picked.listId;
    workspaceId = picked.workspaceId;
  }
  if (!listId) {
    throw new KitError(
      client
        ? 'no ClickUp list chosen. Pass --list <listId> (find it with: tossana-agents clickup lists)'
        : 'no ClickUp token and no list. Add CLICKUP_API_TOKEN to .env, or pass --list <listId>',
    );
  }

  // 5. statuses
  let statuses: Record<Role, string> = { ...DEFAULT_STATUSES, ...existing?.clickup.statuses };
  if (client) {
    const listStatuses = (await client.getList(listId)).statuses ?? [];
    const mapped = mapStatuses(listStatuses, existing?.clickup.statuses);
    statuses = mapped.statuses;
    if (prompts) statuses = await confirmStatuses(prompts, listStatuses, statuses);
    const names = listStatuses.map((s) => s.status.toLowerCase());
    const missing = ROLES.filter((r) => !names.includes(statuses[r].toLowerCase()));
    if (missing.length) {
      ctx.logger.warn(
        `WARNING: the list has no status for: ${missing.map((r) => `${r} ("${statuses[r]}")`).join(', ')}.\n` +
          '  Add them in ClickUp: open the list → ⋯ → List settings → Statuses (exact names), then run: tossana-agents doctor\n' +
          `  ${await wrongAccountHint(client)}`,
      );
    }
  } else {
    ctx.logger.warn('No ClickUp token: using the default status names. Run init again after adding the token.');
  }

  // 6. owner
  if (client && !env.CLICKUP_OWNER_USER_ID) {
    const me = await client.getUser();
    const ok = prompts
      ? await prompts.confirm(`Send "ready for review" notifications to you (${me.username}, id ${me.id})?`, true)
      : true;
    if (ok) {
      setEnvValue(ctx.cwd, 'CLICKUP_OWNER_USER_ID', String(me.id));
      log(`Saved CLICKUP_OWNER_USER_ID=${me.id} to .env.`);
    }
  }

  // 7. config
  const isNode = existsSync(join(ctx.cwd, 'package.json'));
  const raw = {
    ...(isNode ? { $schema: SCHEMA_PATH } : {}),
    ...rawExisting,
    version: 1,
    project: {
      ...(rawExisting.project as object),
      name: existing?.project.name ?? projectName(ctx.cwd),
      type,
      skill,
    },
    clickup: {
      ...(rawExisting.clickup as object),
      listId,
      ...(workspaceId ? { workspaceId } : {}),
      statuses,
    },
    commands: dropEmpty(commands),
    figma: { ...(rawExisting.figma as object), enabled: figma },
    tools,
    pipeline: { ...(rawExisting.pipeline as object) },
  };
  const config = parseConfig(raw);
  // Write the pipeline settings in full (defaults included) so people can see and change them.
  raw.pipeline = { ...config.pipeline, ...(rawExisting.pipeline as object) };
  writeIfChanged(configFile, `${JSON.stringify(raw, null, 2)}\n`, () => log(`Wrote ${CONFIG_FILE}`));

  // 8. .env.example, .gitignore
  const example = join(ctx.cwd, '.env.example');
  if (!existsSync(example)) {
    writeFileSync(example, readTemplate('env.example'));
    log('Wrote .env.example');
  }
  if (ensureGitignore(ctx.cwd)) log('Updated .gitignore');

  // 9. kit files
  const vars = templateVars(config, {
    kitCmd: isNode ? 'npx tossana-agents' : 'tossana-agents',
    cwd: ctx.cwd,
    packageManager: detected.packageManager,
  });
  const agentsMdFile = join(ctx.cwd, 'AGENTS.md');
  const unmarkedAgentsMd = existsSync(agentsMdFile) && findMarker(readFileSync(agentsMdFile, 'utf8')) < 0;
  const results = await applyKitFiles(ctx, kitFiles(config, vars, resolveRoleSkills(ctx.cwd, config)), {
    force: opts.force,
    prompts,
    projectSection: render(readTemplate('AGENTS.project.md'), vars, 'AGENTS.project.md'),
  });
  log('\nKit files:');
  printKitFileResults(ctx, results);
  printFigmaResults(ctx, applyFigmaMcp(ctx.cwd, config));
  printMergeResults(ctx, applyClaudeSettings(ctx.cwd, config, vars['kit.cmd']!), 'Claude Code');
  if (unmarkedAgentsMd) {
    log(
      '  Note: your old AGENTS.md is kept unchanged below <!-- PROJECT -->. Remove rules that are now in the kit part above it.',
    );
  }

  // 10. doctor
  if (opts.doctor !== false) {
    log('');
    printChecks(ctx, await runDoctor(ctx));
  }
  log('\nNext: commit the kit files, then run a task:  tossana-agents run --task <taskId>');
}

// ---------- helpers ----------

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function dropEmpty<T extends Record<string, string | undefined>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Partial<T>;
}

function projectName(cwd: string): string {
  try {
    const pkg = JSON.parse(stripBom(readFileSync(join(cwd, 'package.json'), 'utf8'))) as { name?: string };
    if (pkg.name) return pkg.name;
  } catch {
    // no package.json
  }
  return basename(cwd);
}

function formatCommands(commands: Record<string, string | undefined>): string {
  return `Commands:\n${['install', 'lint', 'typecheck', 'test'].map((k) => `  ${k.padEnd(10)} ${commands[k] ?? '(none)'}`).join('\n')}`;
}

function writeIfChanged(file: string, content: string, onWrite: () => void): void {
  const before = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  if (before === content) return;
  writeFileSync(file, content);
  onWrite();
}

/** Sets KEY=value in .env, keeping every other line. The value is never printed. */
export function setEnvValue(cwd: string, key: string, value: string): void {
  const file = join(cwd, ENV_FILE);
  const text = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd() : '';
  const lines = text ? text.split('\n') : [];
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const at = lines.findIndex((l) => re.test(l));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  if (parseDotEnv(readFileSync(file, 'utf8'))[key] !== value) throw new KitError(`could not write ${key} to .env`);
}

/** Adds the kit's lines to .gitignore when missing. Returns true when the file changed. */
export function ensureGitignore(cwd: string): boolean {
  const file = join(cwd, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  const present = new Set(text.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !gitignoreCovers(present, l));
  if (!missing.length) return false;
  // In .gitignore the last matching rule wins: a new ".env.*" must be followed by "!.env.example"
  // again, or .env.example (which must be committed) becomes ignored.
  if (missing.includes('.env.*') && !missing.includes('!.env.example')) missing.push('!.env.example');
  const block = [...(present.has(GITIGNORE_HEADER) ? [] : [GITIGNORE_HEADER]), ...missing].join('\n');
  const sep = !text ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(file, `${text}${sep}${block}\n`);
  return true;
}

/** True when .gitignore already has this rule or an equivalent/broader one (e.g. ".env*" covers ".env.*"). */
function gitignoreCovers(present: Set<string>, line: string): boolean {
  if (present.has(line)) return true;
  if (line.startsWith('!')) return false;
  const bare = line.replace(/\/$/, '');
  const forms = [bare, `${bare}/`, `${bare}/*`, `${bare}/**`, `/${bare}`, `/${bare}/`, `/${bare}/*`];
  if (forms.some((f) => present.has(f))) return true;
  if (line.startsWith('.env') && (present.has('.env*') || present.has('/.env*'))) return true;
  // A parent folder rule (".agents/") covers everything inside it.
  const parts = bare.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if ([parent, `${parent}/`, `/${parent}/`, `${parent}/*`, `${parent}/**`].some((f) => present.has(f))) return true;
  }
  return false;
}

const ALIASES: Record<Role, string[]> = {
  todo: ['to do', 'todo', 'open', 'backlog'],
  coding: ['coding', 'in progress', 'doing', 'in development', 'development'],
  review: ['in review', 'review', 'code review'],
  testing: ['testing', 'qa', 'in qa', 'test'],
  human: ['ready for review', 'ready for narak', 'ready for approval', 'ready'],
};

/** Matches the list's statuses to roles: existing mapping first, then known names. */
export function mapStatuses(
  listStatuses: ClickUpStatus[],
  existing?: Partial<Record<Role, string>>,
): { statuses: Record<Role, string>; matched: Role[] } {
  const usable = listStatuses.filter((s) => !isClosedType(s.type));
  const find = (name: string) => usable.find((s) => s.status.trim().toLowerCase() === name.trim().toLowerCase());
  const statuses: Record<Role, string> = { ...DEFAULT_STATUSES, ...existing };
  const found = new Map<Role, string>();
  const taken = () => new Set([...found.values()].map((s) => s.toLowerCase()));
  const claim = (role: Role, status: ClickUpStatus | undefined) => {
    if (!status || found.has(role) || taken().has(status.status.toLowerCase())) return;
    found.set(role, status.status);
  };
  // Pass 1: the existing mapping wins wherever the list still has that status.
  for (const role of ROLES) if (existing?.[role]) claim(role, find(existing[role]!));
  // Pass 2: known names, then any "ready for …" status for the human role.
  for (const role of ROLES) for (const alias of ALIASES[role]) claim(role, find(alias));
  claim(
    'human',
    usable.find((s) => s.status.toLowerCase().startsWith('ready for') && !taken().has(s.status.toLowerCase())),
  );

  for (const [role, status] of found) statuses[role] = status;
  return { statuses, matched: ROLES.filter((r) => found.has(r)) };
}

async function confirmStatuses(
  prompts: Prompts,
  listStatuses: ClickUpStatus[],
  statuses: Record<Role, string>,
): Promise<Record<Role, string>> {
  const summary = ROLES.map((r) => `${r} → "${statuses[r]}"`).join(', ');
  if (await prompts.confirm(`Status mapping: ${summary}. OK?`, true)) return statuses;
  const result = { ...statuses };
  const choices = listStatuses
    .filter((s) => !isClosedType(s.type))
    .map((s) => ({ value: s.status, label: s.status, hint: s.type ?? undefined }));
  for (const role of ROLES) {
    const missingChoice = {
      value: `__missing__${role}`,
      label: `(missing: I will add "${DEFAULT_STATUSES[role]}" in ClickUp)`,
    };
    const pick = await prompts.select(`Status for "${role}"`, [...choices, missingChoice], result[role]);
    result[role] = pick.startsWith('__missing__') ? DEFAULT_STATUSES[role] : pick;
  }
  return result;
}

async function pickList(
  client: ClickUpClient,
  prompts: Prompts,
  current?: string,
): Promise<{ listId: string; workspaceId?: string }> {
  const choices: { value: string; label: string; workspaceId: string }[] = [];
  for (const team of await client.getWorkspaces()) {
    for (const space of await client.getSpaces(team.id)) {
      for (const folder of await client.getFolders(space.id)) {
        for (const l of folder.lists ?? []) {
          choices.push({
            value: l.id,
            label: `${team.name} / ${space.name} / ${folder.name} / ${l.name}`,
            workspaceId: team.id,
          });
        }
      }
      for (const l of await client.getFolderlessLists(space.id)) {
        choices.push({ value: l.id, label: `${team.name} / ${space.name} / ${l.name}`, workspaceId: team.id });
      }
    }
  }
  if (!choices.length) throw new KitError('your token cannot see any ClickUp lists');
  const listId = await prompts.select(
    "Which ClickUp list holds this project's tasks?",
    choices.map((c) => ({ value: c.value, label: c.label, hint: c.value })),
    current,
  );
  return { listId, workspaceId: choices.find((c) => c.value === listId)?.workspaceId };
}
