/**
 * `tossana-agents agents list | create | delete`: agent profiles (plan Phase 9). The Local Console's Agents tab
 * does the same with a form.
 */
import type { Command } from 'commander';
import {
  AGENT_TOOLS,
  KitError,
  MCP_CATALOG,
  PROFILE_COLORS,
  profileLabel,
  profileSlug,
  type AgentProfileInput,
} from '@tossana/agents-core';
import { loadProject, type CliContext } from '../context.js';
import { availableSkills, deleteProfile, listProfiles, saveProfile } from '../profiles.js';
import { clackPrompts, type Prompts } from '../prompts.js';
import { toolStatuses } from '../tool-status.js';
import { registerSkillsCommands } from './skills.js';

interface CreateOptions {
  name: string;
  tool: string;
  id?: string;
  skills?: string;
  mcp?: string;
  initials?: string;
  color?: string;
  personal?: boolean;
  replace?: boolean;
}

const csv = (s: string | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function registerAgentsCommand(program: Command, ctx: CliContext, prompts: Prompts = clackPrompts): void {
  const agents = program
    .command('agents')
    .description('the pipeline agents (coder, reviewer, tester: their skills) and agent profiles (name + tool)');
  const print = (s: string) => ctx.logger.info(s);

  agents
    .command('list')
    .description('team agents (this project) and personal agents (this machine)')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) => {
      const all = listProfiles(ctx);
      const config = loadProject(ctx).config;
      const tools = toolStatuses(
        ctx,
        config,
        all.flatMap((p) => (p.profile ? [p.profile.tool] : [])),
      );
      if (opts.json) {
        print(
          JSON.stringify(
            all.map((p) => ({ ...p, file: undefined, tool: p.profile ? tools.get(p.profile.tool) : undefined })),
            null,
            2,
          ),
        );
        return;
      }
      if (!all.length) {
        print('No agents yet. Create one: tossana-agents agents create --name "Rei – Mobile" --tool codex');
        return;
      }
      for (const p of all) {
        if (!p.profile) {
          print(`✗ ${p.slug} (${p.scope}): ${p.error}`);
          continue;
        }
        const t = tools.get(p.profile.tool)!;
        const state = [
          t.installed === null
            ? 'IDE, not checked'
            : t.installed
              ? `installed ${t.version ?? ''}`.trim()
              : 'NOT installed',
          t.setUp ? 'set up here' : 'NOT set up in this project',
        ].join(', ');
        print(`${p.slug}  ${profileLabel(p.profile.name, p.profile.tool)}  (${p.scope}; ${state})`);
        if (p.profile.skills.length) print(`    skills: ${p.profile.skills.join(', ')}`);
        if (p.profile.mcp.length) print(`    MCP: ${p.profile.mcp.join(', ')}`);
      }
    });

  agents
    .command('create')
    .description('create an agent profile (team: .agents/profiles/, committed; --personal: ~/.agents/profiles/)')
    .requiredOption('--name <name>', 'display name, e.g. "Rei – Mobile"')
    .requiredOption('--tool <tool>', `agent tool (${AGENT_TOOLS.join(', ')})`)
    .option('--id <id>', 'file name / id (default: from the name, e.g. rei-mobile)')
    .option('--skills <list>', 'skills, comma-separated (project, user or team scope)')
    .option('--mcp <list>', `MCP servers, comma-separated (${MCP_CATALOG.join(', ')})`)
    .option('--initials <text>', 'up to 3 characters for the badge')
    .option('--color <color>', `badge color (${PROFILE_COLORS.join(', ')})`)
    .option('--personal', 'only on this machine (~/.agents/profiles/)')
    .option('--replace', 'replace an existing agent with the same id')
    .action((opts: CreateOptions) => {
      const slug = opts.id ?? profileSlug(opts.name);
      if (!slug)
        throw new KitError('the name has no Latin letters or digits for an id; pass one with --id, e.g. --id rei');
      const input: AgentProfileInput = {
        name: opts.name,
        tool: opts.tool as AgentProfileInput['tool'],
        skills: csv(opts.skills),
        mcp: csv(opts.mcp) as AgentProfileInput['mcp'],
        ...(opts.initials ? { initials: opts.initials } : {}),
        ...(opts.color ? { color: opts.color as AgentProfileInput['color'] } : {}),
      };
      const scope = opts.personal ? 'personal' : 'team';
      const saved = saveProfile(ctx, { scope, slug, profile: input, replace: opts.replace });
      print(`Saved ${scope} agent "${slug}": ${profileLabel(saved.profile.name, saved.profile.tool)}`);
      print(`  ${saved.file}`);
      const known = new Set(availableSkills(ctx).map((s) => s.name));
      const missing = saved.profile.skills.filter((s) => !known.has(s));
      if (missing.length) ctx.logger.warn(`  warning: skills not found on this machine: ${missing.join(', ')}`);
      if (scope === 'team') print('  Commit it so your team gets this agent too.');
      print(`  Use it: tossana-agents run --task <taskId> --agent ${slug}`);
    });

  agents
    .command('delete <id>')
    .description('delete an agent profile')
    .option('--personal', 'the personal agent (default: the team agent)')
    .option('-y, --yes', 'do not ask')
    .action(async (slug: string, opts: { personal?: boolean; yes?: boolean }) => {
      const scope = opts.personal ? 'personal' : 'team';
      const ok =
        opts.yes ||
        (ctx.io.interactive && (await (ctx.prompts ?? prompts).confirm(`Delete the ${scope} agent "${slug}"?`, false)));
      if (!ok) throw new KitError(`not deleted. Run again with --yes to delete the ${scope} agent "${slug}".`);
      const file = deleteProfile(ctx, scope, slug);
      print(`Deleted ${file}`);
    });

  registerSkillsCommands(agents, program, ctx);
}
