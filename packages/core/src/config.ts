/**
 * agent.config.json (committed, project-owned) and .env (personal, never committed).
 * The zod schema is the source of truth; the JSON Schema for editors is generated from it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClickUpClientOptions } from './clickup/client.js';
import { statusNameRefusal } from './clickup/guard.js';
import { ConfigError } from './errors.js';

export const CONFIG_FILE = 'agent.config.json';
export const ENV_FILE = '.env';

export const PROJECT_TYPES = ['react-native', 'flutter', 'nextjs', 'react', 'node-backend', 'other'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const ROLES = ['todo', 'coding', 'review', 'testing', 'human'] as const;
export type Role = (typeof ROLES)[number];

export const RUNNERS = ['opencode', 'claude-code', 'custom'] as const;
export type RunnerName = (typeof RUNNERS)[number];

export const DEFAULT_STATUSES: Record<Role, string> = {
  todo: 'to do',
  coding: 'coding',
  review: 'in review',
  testing: 'testing',
  human: 'ready for review',
};

const statusName = (role: Role) =>
  z.string().trim().min(1).default(DEFAULT_STATUSES[role]).describe(`Exact ClickUp status name for the "${role}" role`);

const statusesSchema = z
  .object({
    todo: statusName('todo'),
    coding: statusName('coding'),
    review: statusName('review'),
    testing: statusName('testing'),
    human: statusName('human').describe('Final status agents may set. Never a done/closed status.'),
  })
  .superRefine((statuses, ctx) => {
    const names = Object.values(statuses);
    for (const role of ROLES) {
      const why = statusNameRefusal(statuses[role], names);
      if (why) ctx.addIssue({ code: 'custom', path: [role], message: `agents could never set this status: ${why}` });
    }
    const seen = new Map<string, Role>();
    for (const role of ROLES) {
      const key = statuses[role].toLowerCase();
      const other = seen.get(key);
      if (other) ctx.addIssue({ code: 'custom', path: [role], message: `same status as "${other}"` });
      seen.set(key, role);
    }
  });

const command = z.string().trim().describe('Shell command, run from the project root');

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    project: z.object({
      name: z.string().trim().min(1),
      type: z.enum(PROJECT_TYPES),
      skill: z.string().trim().min(1).describe('Skill the coder uses, e.g. mobile-master'),
    }),
    clickup: z.object({
      listId: z.string().trim().min(1).describe('ClickUp list the tasks live in'),
      statuses: statusesSchema.prefault({}),
      workspaceId: z.string().trim().min(1).optional().describe('Needed for custom task IDs and ClickUp Docs'),
      customTaskIds: z.boolean().default(false).describe('Tasks use custom IDs like EKM-123'),
      docs: z
        .object({
          ids: z.array(z.string().trim().min(1)).default([]).describe('ClickUp Doc IDs to sync for agents to read'),
          outDir: z.string().trim().min(1).default('docs/clickup'),
        })
        .prefault({}),
    }),
    commands: z
      .object({
        install: command.optional(),
        lint: command.optional(),
        typecheck: command.optional(),
        test: command.optional(),
      })
      .prefault({}),
    pipeline: z
      .object({
        maxRounds: z.number().int().min(1).max(20).default(5),
        branchPrefix: z.string().default('task/'),
        baseBranch: z.string().trim().min(1).default('main'),
        requireCleanGit: z.boolean().default(true),
        runner: z.enum(RUNNERS).default('opencode'),
        timeoutMinutes: z.number().positive().default(120),
      })
      .prefault({}),
  })
  .describe('Tossana agent kit project config');

export type AgentConfig = z.output<typeof configSchema>;
export type AgentConfigInput = z.input<typeof configSchema>;

/** JSON Schema for agent.config.json, for editor autocomplete. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(configSchema, { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
}

export function parseConfig(raw: unknown, source = CONFIG_FILE): AgentConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  throw new ConfigError(`${source} is not valid:\n${lines.join('\n')}`);
}

export function loadConfig(cwd: string): AgentConfig {
  const file = join(cwd, CONFIG_FILE);
  if (!existsSync(file)) throw new ConfigError(`${CONFIG_FILE} not found in ${cwd}. Run: tossana-agents init`);
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch (e) {
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw, CONFIG_FILE);
}

/** The ClickUp status name for a role. */
export function statusForRole(config: AgentConfig, role: Role): string {
  return config.clickup.statuses[role];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The guard's allow-list: every status mapped to a role. */
export function agentStatusNames(config: AgentConfig): string[] {
  return ROLES.map((r) => config.clickup.statuses[r]);
}

// ---------- .env ----------

export interface KitEnv {
  CLICKUP_API_TOKEN?: string;
  CLICKUP_OWNER_USER_ID?: string;
  AGENT_CMD?: string;
  CLICKUP_WORKSPACE_ID?: string;
  CLICKUP_CUSTOM_TASK_IDS?: string;
  CLICKUP_DOC_IDS?: string;
  CLICKUP_DOCS_OUT?: string;
  [key: string]: string | undefined;
}

/** Parses KEY=value lines. Handles CRLF, a BOM, `export KEY=`, comments and quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stripBom(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]!] = value;
  }
  return out;
}

/**
 * Reads `<cwd>/.env`. Values already set in the real environment win, like the original
 * clickup.ts. Does not change process.env.
 */
export function loadEnv(cwd: string, processEnv: Record<string, string | undefined> = process.env): KitEnv {
  const file = join(cwd, ENV_FILE);
  const fromFile = existsSync(file) ? parseDotEnv(readFileSync(file, 'utf8')) : {};
  const env: KitEnv = { ...fromFile };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}

/** Client options from config + env. Env overrides the config's workspace/custom-ID settings. */
export function clickUpClientOptions(config: AgentConfig, env: KitEnv): ClickUpClientOptions {
  const customIds = env.CLICKUP_CUSTOM_TASK_IDS;
  return {
    token: env.CLICKUP_API_TOKEN ?? '',
    workspaceId: env.CLICKUP_WORKSPACE_ID || config.clickup.workspaceId,
    customTaskIds: customIds ? customIds.trim().toLowerCase() === 'true' : config.clickup.customTaskIds,
    agentStatuses: agentStatusNames(config),
  };
}

/** ClickUp Doc IDs and output folder from config, overridden by CLICKUP_DOC_IDS / CLICKUP_DOCS_OUT. */
export function docsSettings(config: AgentConfig, env: KitEnv): { ids: string[]; outDir: string } {
  const fromEnv = (env.CLICKUP_DOC_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ids: fromEnv.length ? fromEnv : config.clickup.docs.ids,
    outDir: env.CLICKUP_DOCS_OUT || config.clickup.docs.outDir,
  };
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
