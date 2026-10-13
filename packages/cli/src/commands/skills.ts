/**
 * Per-agent skills of the fixed pipeline, and team skills:
 *   tossana-agents agents skills [role] [add|remove|reset] [skill]
 *   tossana-agents skills [list | customize <skill> | reset <skill>]
 * Every change is written to agent.config.json ("agents") and the agent files are refreshed at once (like update).
 */
import type { Command } from 'commander';
import {
  AGENT_ROLES,
  KitError,
  agentSkills,
  defaultAgentSkills,
  type AgentConfig,
  type AgentRole,
} from '@tossana/agents-core';
import { customizeSkill, readRawConfig, resetSkill, usesCustomRoles, writeRawConfig } from '../agent-skills.js';
import { loadProject, requireConfig, type CliContext } from '../context.js';
import { availableSkills } from '../profiles.js';
import { toAgentsSection, updateProject } from './update.js';

const ACTIONS = ['add', 'remove', 'reset'] as const;

export function registerSkillsCommands(agents: Command, program: Command, ctx: CliContext): void {
  const print = (s: string) => ctx.logger.info(s);

  agents
    .command('skills [role] [action] [skill]')
    .description(`show or change the skills of an agent (${AGENT_ROLES.join(', ')}): add|remove <skill>, reset`)
    .action(async (role?: string, action?: string, skill?: string) => {
      const config = requireConfig(loadProject(ctx));
      if (usesCustomRoles(readRawConfig(ctx.cwd))) {
        throw new KitError(
          'this project uses custom roles (advanced): edit roles[].skills in agent.config.json instead.',
        );
      }
      if (role === undefined) {
        printAgentSkills(ctx, config);
        return;
      }
      if (!(AGENT_ROLES as readonly string[]).includes(role)) {
        throw new KitError(`"${role}" is not an agent of the pipeline. Agents: ${AGENT_ROLES.join(', ')}`);
      }
      const r = role as AgentRole;
      const current = agentSkills(config)[r];
      if (action === undefined) {
        printAgentSkills(ctx, config, r);
        return;
      }
      if (!(ACTIONS as readonly string[]).includes(action)) {
        throw new KitError(`unknown action "${action}". Use: add <skill>, remove <skill> or reset`);
      }
      let next: string[];
      if (action === 'reset') {
        next = defaultAgentSkills(config)[r];
      } else {
        if (!skill) throw new KitError(`which skill? tossana-agents agents skills ${r} ${action} <skill>`);
        if (action === 'add') {
          const known = availableSkills(ctx);
          if (!known.some((s) => s.name === skill)) {
            throw new KitError(
              `no skill "${skill}". Available: ${known.map((s) => s.name).join(', ')}. ` +
                `Add your own in .agents/skills/${skill}/SKILL.md (project) or ~/.agents/skills/${skill}/SKILL.md (only you).`,
            );
          }
          if (current.includes(skill)) throw new KitError(`the ${r} already has "${skill}".`);
          next = [...current, skill];
        } else {
          if (!current.includes(skill))
            throw new KitError(`the ${r} does not have "${skill}". It has: ${current.join(', ') || '(none)'}`);
          next = current.filter((s) => s !== skill);
        }
      }
      const raw = readRawConfig(ctx.cwd);
      const all = { ...agentSkills(config), [r]: next };
      raw.agents = toAgentsSection(all);
      writeRawConfig(ctx.cwd, raw);
      print(`${r}: ${next.join(', ') || '(no skills)'}`);
      await updateProject(ctx, { prompts: null });
    });

  const skills = program.command('skills').description('team, project and personal skills');

  skills
    .command('list', { isDefault: true })
    .description('every skill the agents can use here, and which agent uses it')
    .action(() => {
      const config = loadProject(ctx).config;
      const used = config ? agentSkills(config) : null;
      for (const s of availableSkills(ctx)) {
        const by = used ? AGENT_ROLES.filter((r) => used[r].includes(s.name)) : [];
        print(`${s.name.padEnd(22)} ${s.scope.padEnd(8)} ${by.length ? `used by ${by.join(', ')}` : ''}`.trimEnd());
        if (s.description) print(`  ${s.description}`);
      }
    });

  skills
    .command('customize <skill>')
    .description('copy a team skill into .agents/skills/ to edit it; the project copy wins and update keeps it')
    .action(async (skill: string) => {
      requireConfig(loadProject(ctx));
      const folder = customizeSkill(ctx.cwd, skill);
      print(`${folder}/SKILL.md is now this project's own copy: edit it and commit it.`);
      print(`Back to the team version: tossana-agents skills reset ${skill}`);
      await updateProject(ctx, { prompts: null });
    });

  skills
    .command('reset <skill>')
    .description('go back to the team version of a skill you customized (your copy is kept as a backup)')
    .action(async (skill: string) => {
      requireConfig(loadProject(ctx));
      const backup = resetSkill(ctx.cwd, skill, ctx.now());
      print(`Your copy was moved to ${backup}.`);
      await updateProject(ctx, { prompts: null });
    });
}

function printAgentSkills(ctx: CliContext, config: AgentConfig, only?: AgentRole): void {
  const current = agentSkills(config);
  const defaults = defaultAgentSkills(config);
  const scope = new Map(availableSkills(ctx).map((s) => [s.name, s.scope]));
  for (const role of only ? [only] : AGENT_ROLES) {
    const list = current[role].map((s) => `${s} (${scope.get(s) ?? 'missing'})`).join(', ') || '(no skills)';
    const isDefault =
      current[role].length === defaults[role].length && current[role].every((s) => defaults[role].includes(s));
    ctx.logger.info(
      `${role.padEnd(8)} ${list}${isDefault ? '' : `   [default: ${defaults[role].join(', ') || 'none'}]`}`,
    );
  }
}
