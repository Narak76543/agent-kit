/**
 * Everything a command needs from the outside world, so commands can run in-process in tests
 * (fake fetch, captured output, temp folders) exactly as they run for real.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClickUpClient,
  CONFIG_FILE,
  ConfigError,
  clickUpClientOptions,
  createLogger,
  loadConfig,
  loadEnv,
  type AgentConfig,
  type FetchLike,
  type KitEnv,
  type Logger,
} from '@tossana/agents-core';

export interface CliIO {
  /** Raw write to stdout (include your own newline). */
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
  /** True when a person can answer prompts. */
  interactive: boolean;
}

export interface CliContext {
  cwd: string;
  /** The real process environment (not .env). */
  processEnv: Record<string, string | undefined>;
  io: CliIO;
  logger: Logger;
  fetch?: FetchLike;
  now: () => Date;
}

/** Test-only API URL override; ignored unless it points at this machine, so a .env can never redirect the token. */
export const API_URL_ENV = 'TOSSANA_CLICKUP_API_URL';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createContext(options: {
  cwd?: string;
  processEnv?: Record<string, string | undefined>;
  io?: Partial<CliIO>;
  fetch?: FetchLike;
  now?: () => Date;
}): CliContext {
  const io: CliIO = {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    readStdin: readProcessStdin,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ...options.io,
  };
  const logger = createLogger({ stdout: (l) => io.out(`${l}\n`), stderr: (l) => io.err(`${l}\n`) });
  return {
    cwd: options.cwd ?? process.cwd(),
    processEnv: options.processEnv ?? process.env,
    io,
    logger,
    fetch: options.fetch,
    now: options.now ?? (() => new Date()),
  };
}

export interface Project {
  /** `null` before `init` has written agent.config.json. */
  config: AgentConfig | null;
  env: KitEnv;
}

export function loadProject(ctx: CliContext): Project {
  const env = loadEnv(ctx.cwd, ctx.processEnv);
  ctx.logger.addSecret(env.CLICKUP_API_TOKEN);
  const config = existsSync(join(ctx.cwd, CONFIG_FILE)) ? loadConfig(ctx.cwd) : null;
  return { config, env };
}

export function requireConfig(project: Project): AgentConfig {
  if (!project.config) throw new ConfigError(`${CONFIG_FILE} not found. Run: tossana-agents init`);
  return project.config;
}

export function apiBaseUrl(ctx: CliContext): string | undefined {
  const raw = ctx.processEnv[API_URL_ENV];
  if (!raw) return undefined;
  try {
    if (LOCAL_HOSTS.has(new URL(raw).hostname)) return raw;
  } catch {
    // fall through
  }
  ctx.logger.warn(`[clickup] ignoring ${API_URL_ENV}: only localhost URLs are allowed`);
  return undefined;
}

export function createClient(ctx: CliContext, project: Project): ClickUpClient {
  return new ClickUpClient({
    ...clickUpClientOptions(project.config, project.env),
    fetch: ctx.fetch,
    baseUrl: apiBaseUrl(ctx),
    logger: ctx.logger,
  });
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
