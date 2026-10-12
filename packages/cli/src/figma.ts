/**
 * Optional Figma support: the Figma MCP server in the project's OpenCode config (`opencode.json`) and
 * Antigravity config (`.agents/mcp_config.json`). Both files may hold the user's own settings, so the kit
 * only merges (or removes) its `figma` entry and never owns the whole file. No Figma token is ever written:
 * the desktop server needs none, the remote server uses each developer's own OAuth login.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FIGMA_MCP_URL, type AgentConfig, type FetchLike } from '@tossana/agents-core';
import type { Check } from './commands/doctor.js';
import type { CliContext } from './context.js';

export const FIGMA_SERVER_NAME = 'figma';

/** Read-only Figma MCP tools the coder and reviewer may call. Everything else (writes, Weave, shaders) stays denied. */
export const FIGMA_READ_TOOLS = ['get_design_context', 'get_metadata', 'get_variable_defs', 'get_screenshot', 'whoami'];

export const OPENCODE_CONFIG = 'opencode.json';
export const ANTIGRAVITY_MCP_CONFIG = '.agents/mcp_config.json';
export const CLAUDE_MCP_CONFIG = '.mcp.json';

const OUR_URLS = new Set(Object.values(FIGMA_MCP_URL));
const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

type Json = Record<string, unknown>;

export interface FigmaFileResult {
  path: string;
  action: 'added' | 'updated' | 'removed' | 'unchanged' | 'manual';
  /** For "manual": what to add by hand. */
  hint?: string;
}

function opencodeEntry(config: AgentConfig): Json {
  const url = FIGMA_MCP_URL[config.figma.server];
  // The desktop server has no auth; "oauth: false" stops OpenCode from trying an OAuth flow against it.
  return config.figma.server === 'desktop'
    ? { type: 'remote', url, enabled: true, oauth: false }
    : { type: 'remote', url, enabled: true };
}

const antigravityEntry = (config: AgentConfig): Json => ({ serverUrl: FIGMA_MCP_URL[config.figma.server] });

/** Adds, updates or removes the kit's Figma MCP entry in both config files. */
export function applyFigmaMcp(cwd: string, config: AgentConfig): FigmaFileResult[] {
  return [
    mergeEntry(cwd, OPENCODE_CONFIG, 'mcp', config.figma.enabled ? opencodeEntry(config) : null, {
      $schema: 'https://opencode.ai/config.json',
    }),
    mergeEntry(cwd, ANTIGRAVITY_MCP_CONFIG, 'mcpServers', config.figma.enabled ? antigravityEntry(config) : null, {}),
    // Claude Code's project MCP file (https://code.claude.com/docs/en/mcp), only when Claude Code is used.
    mergeEntry(
      cwd,
      CLAUDE_MCP_CONFIG,
      'mcpServers',
      config.figma.enabled && config.tools.includes('claude-code')
        ? { type: 'http', url: FIGMA_MCP_URL[config.figma.server] }
        : null,
      {},
    ),
  ];
}

function mergeEntry(cwd: string, rel: string, key: string, entry: Json | null, base: Json): FigmaFileResult {
  const file = join(cwd, rel);
  const manual = (why: string): FigmaFileResult => ({
    path: rel,
    action: 'manual',
    hint: `${why} Add this under "${key}" yourself: "${FIGMA_SERVER_NAME}": ${JSON.stringify(entry)}`,
  });

  let data: Json;
  if (existsSync(file)) {
    try {
      data = JSON.parse(stripBom(readFileSync(file, 'utf8'))) as Json;
    } catch {
      if (!entry) return { path: rel, action: 'unchanged' };
      return manual(`${rel} is not plain JSON (comments?), so the kit does not change it.`);
    }
  } else {
    if (!entry) return { path: rel, action: 'unchanged' };
    data = { ...base };
  }

  const { [FIGMA_SERVER_NAME]: current, ...others } = (data[key] ?? {}) as Record<string, Json | undefined>;
  if (!entry) {
    // Only remove an entry the kit wrote (one of Figma's URLs), never a server the user set up differently.
    const url = current?.url ?? current?.serverUrl;
    if (!current || typeof url !== 'string' || !OUR_URLS.has(url)) return { path: rel, action: 'unchanged' };
    data[key] = others;
  } else {
    if (JSON.stringify(current) === JSON.stringify(entry)) return { path: rel, action: 'unchanged' };
    data[key] = { ...others, [FIGMA_SERVER_NAME]: entry };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { path: rel, action: !entry ? 'removed' : current ? 'updated' : 'added' };
}

export function printFigmaResults(ctx: CliContext, results: FigmaFileResult[]): void {
  printMergeResults(ctx, results, 'Figma MCP server');
}

/** Prints merged (not kit-owned) config files: only the kit's own entries were added or removed. */
export function printMergeResults(ctx: CliContext, results: FigmaFileResult[], what: string): void {
  for (const r of results) {
    if (r.action === 'manual') ctx.logger.warn(`  ${what}: ${r.hint}`);
    else if (r.action !== 'unchanged') ctx.logger.info(`  ${r.action.padEnd(8)} ${r.path} (${what})`);
  }
}

/** Doctor checks, only when Figma is enabled. `fetch` is used once, for the local desktop server only. */
export async function figmaChecks(cwd: string, config: AgentConfig, fetchFn: FetchLike): Promise<Check[]> {
  if (!config.figma.enabled) return [];
  const url = FIGMA_MCP_URL[config.figma.server];
  const checks: Check[] = [];
  const fix = 'Run: tossana-agents init (it adds the Figma MCP server), or see docs/getting-started.md → Figma.';

  for (const [rel, key, field] of [
    [OPENCODE_CONFIG, 'mcp', 'url'],
    [ANTIGRAVITY_MCP_CONFIG, 'mcpServers', 'serverUrl'],
  ] as const) {
    let found: unknown;
    try {
      const data = JSON.parse(stripBom(readFileSync(join(cwd, rel), 'utf8'))) as Json;
      found = ((data[key] as Json | undefined)?.[FIGMA_SERVER_NAME] as Json | undefined)?.[field];
    } catch {
      found = undefined;
    }
    checks.push(
      found === url
        ? { name: `Figma MCP server in ${rel}`, status: 'ok' }
        : {
            name: `Figma MCP server in ${rel}`,
            status: 'fail',
            detail: found ? `It points to ${String(found)}, expected ${url}.` : `No "${FIGMA_SERVER_NAME}" server.`,
            fix,
          },
    );
  }

  if (config.figma.server === 'desktop') {
    let up: boolean;
    try {
      // Any HTTP answer means the desktop app's server is listening (MCP endpoints reject a plain GET).
      await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(1500) });
      up = true;
    } catch {
      up = false;
    }
    checks.push(
      up
        ? { name: `Figma desktop MCP server is running (${url})`, status: 'ok' }
        : {
            name: `Figma desktop MCP server is running (${url})`,
            status: 'warn',
            detail: 'Only needed for tasks with a Figma link.',
            fix: 'Open the Figma desktop app, open a design file, switch to Dev Mode (Shift+D) and click "Enable desktop MCP server".',
          },
    );
  }

  checks.push({
    name: 'Figma seats',
    status: 'ok',
    detail:
      'Note: agents need a Dev or Full Figma seat. View and Collab seats get only 20 Figma MCP calls per month. ' +
      'Each developer uses their own Figma login; no Figma token is stored in the project.',
  });
  return checks;
}
