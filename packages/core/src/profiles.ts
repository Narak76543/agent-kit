/**
 * Agent profiles (plan Phase 9): a named agent ("Rei – Mobile") = a tool + extra skills + MCP servers.
 * The pipeline stays the project's; a profile adds knowledge to the coding and review roles, never permissions.
 *
 * Team profiles live in the project (.agents/profiles/<slug>.json, committed); personal profiles in
 * ~/.agents/profiles/<slug>.json (this machine only). The schema is strict, so nothing else (e.g. a token) can be
 * stored in a profile, and values that look like secrets are refused.
 */
import { z } from 'zod';
import { AGENT_TOOLS, MCP_CATALOG, type AgentTool } from './config.js';
import { REDACTED, redact } from './logger.js';
import { ROLE_NAME } from './protocol.js';

export const PROFILE_SCOPES = ['team', 'personal'] as const;
export type ProfileScope = (typeof PROFILE_SCOPES)[number];

/** Badge colors: names of design-token accents (never free CSS). */
export const PROFILE_COLORS = ['green', 'blue', 'amber', 'red', 'gray'] as const;

export const TOOL_LABELS: Record<AgentTool | 'custom', string> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  custom: 'Custom command',
};

/** File names: lower-case letters, digits and single hyphens (same rule as role names). */
export const PROFILE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Long random-looking runs of letters/digits (API keys, tokens) are not names. */
const SECRET_LIKE = /(?:[A-Za-z0-9_-]{32,})|(?:\b(?:sk|ghp|gho|xox[abp]|figd|glpat)[-_][A-Za-z0-9_-]{8,})/;

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\r\n]/.test(v), 'one line only')
    .refine((v) => !/["[\]]/.test(v), 'no quotes or square brackets')
    .refine((v) => redact(v) === v && !v.includes(REDACTED) && !SECRET_LIKE.test(v), 'looks like a secret');

export const profileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    version: z.literal(1).default(1),
    name: safeText(60).describe('Shown in the console, comments and the dashboard, e.g. "Rei – Mobile"'),
    initials: safeText(3).optional().describe('Up to 3 characters for the badge, e.g. "RM"'),
    color: z.enum(PROFILE_COLORS).optional().describe('Badge color'),
    tool: z.enum(AGENT_TOOLS).describe('Agent tool that runs the pipeline'),
    skills: z
      .array(z.string().regex(ROLE_NAME, 'skill names use lower-case letters, digits and hyphens'))
      .max(20)
      .default([])
      .refine((s) => new Set(s).size === s.length, 'a skill is listed twice')
      .describe('Extra skills for the coding and review roles (project, user or team scope)'),
    mcp: z
      .array(z.enum(MCP_CATALOG))
      .default([])
      .refine((s) => new Set(s).size === s.length, 'an MCP server is listed twice')
      .describe('MCP servers from the approved catalog this agent uses'),
  })
  .describe('Tossana agent profile');

export type AgentProfile = z.output<typeof profileSchema>;
export type AgentProfileInput = z.input<typeof profileSchema>;

export function parseProfile(raw: unknown, source = 'profile'): AgentProfile {
  const r = profileSchema.safeParse(raw);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new ProfileError(`${source} is not valid:\n${lines.join('\n')}`);
}

export class ProfileError extends Error {}

/** "Rei – Mobile" → "rei-mobile". Empty when the name has no Latin letters or digits (then ask for one). */
export function profileSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** "RM" from "Rei – Mobile"; first letters of the first two words. */
export function profileInitials(profile: Pick<AgentProfile, 'name' | 'initials'>): string {
  if (profile.initials) return profile.initials;
  const words = profile.name.split(/[\s\-–—·_/]+/u).filter((w) => /\p{L}|\p{N}/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join('');
}

/** "Rei – Mobile · Codex": how comments, the handoff file and the dashboard name who ran a task. */
export const profileLabel = (name: string | null | undefined, tool: string) =>
  `${name ? `${name} · ` : ''}${TOOL_LABELS[tool as AgentTool] ?? tool}`;
