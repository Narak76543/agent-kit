/**
 * `tossana-agents antigravity permissions [--yes]`: adds the narrow allow rules a headless Antigravity run needs to the
 * user's agy settings (~/.gemini/antigravity-cli/settings.json). Shows them first; writes only after a yes.
 */
import type { Command } from 'commander';
import { KitError } from '@tossana/agents-core';
import {
  addAntigravityRules,
  agySettingsFile,
  antigravityRules,
  antigravityState,
  kitCommand,
} from '../antigravity.js';
import { antigravityAgents, runAgyCheck } from '../agy-check.js';
import { SilentExit, loadProject, requireConfig, type CliContext } from '../context.js';
import { versionOf } from '../exec.js';
import { clackPrompts, type Prompts } from '../prompts.js';

export function registerAntigravityCommand(program: Command, ctx: CliContext, prompts: Prompts = clackPrompts): void {
  const ag = program.command('antigravity').description('Antigravity CLI (agy) setup for headless runs');
  const print = (s: string) => ctx.logger.info(s);

  ag.command('permissions')
    .description('allow the commands the agents need in your agy settings (headless agy refuses everything else)')
    .option('-y, --yes', 'do not ask')
    .action(async (opts: { yes?: boolean }) => {
      const config = requireConfig(loadProject(ctx));
      const kitCmd = kitCommand(ctx.cwd);
      const rules = antigravityRules(config, kitCmd);
      const state = antigravityState(ctx.home, ctx.cwd, rules);
      const file = agySettingsFile(ctx.home);
      if (!state.missing.length) {
        print(`All ${rules.length} rules are already in ${file}.`);
      } else {
        print(`These rules would be added to "permissions.allow" in ${file}:`);
        for (const r of state.missing) print(`  ${r}`);
        print('They apply to every agy session on this computer. Nothing else in the file changes; a backup is kept.');
        const ok =
          opts.yes || (ctx.io.interactive && (await (ctx.prompts ?? prompts).confirm('Add these rules?', true)));
        if (!ok) throw new KitError('nothing changed. Run again with --yes to add the rules.');
        const result = addAntigravityRules(ctx.home, rules, ctx.now());
        print(`Added ${result.added.length} rule(s).${result.backup ? ` Backup: ${result.backup}` : ''}`);
      }
      if (!state.trusted)
        print('Also: run "agy" once in this folder and choose to trust it, or it will not load the agents.');
      if (state.tooBroad.length) {
        ctx.logger.warn(
          `warning: these rules in ${file} also allow "git push" or any command: ${state.tooBroad.join(', ')}. Remove them.`,
        );
      }
    });

  ag.command('check')
    .description(
      'start every Antigravity agent once ("reply pong") to make sure agy accepts it (one short model call each)',
    )
    .action(() => {
      const version = versionOf(ctx.exec, 'agy', ctx.cwd);
      if (!version)
        throw new KitError('agy is not installed. Install the Antigravity CLI from https://antigravity.google');
      const agents = antigravityAgents(ctx.cwd);
      if (!agents.length) {
        throw new KitError(
          'no Antigravity agents in .agents/agents/. Add the tool: tossana-agents init --tools …,antigravity',
        );
      }
      print(`Starting ${agents.length} agent(s) with agy ${version}:`);
      const check = runAgyCheck(ctx, print);
      for (const a of check.agents) print(`${a.ok ? '✓' : '✗'} ${a.agent}${a.ok ? ': pong' : `: ${a.problem}`}`);
      if (check.agents.some((a) => !a.ok)) {
        ctx.logger.error(
          'Not every agent can start. Fix the agent files (kit files: tossana-agents update) and check again.',
        );
        throw new SilentExit(1);
      }
      print('All agents start. The result is remembered until agy or the agent files change.');
    });
}
