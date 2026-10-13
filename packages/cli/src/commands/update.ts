/**
 * `tossana-agents update`: brings kit-owned files up to the installed kit version. Files you edited
 * are shown as a diff and only replaced after you confirm (or with --force; a backup is kept).
 * Project-owned files (agent.config.json, .env, the AGENTS.md project section) are never touched.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { detectPackageManager } from '@tossana/agents-core';
import { loadProject, requireConfig, type CliContext } from '../context.js';
import { applyKitFiles, migrateAntigravityAgents, migrateDraftsDir, printKitFileResults } from '../kit-files.js';
import { readManifest } from '../kit-manifest.js';
import { clackPrompts, type Prompts } from '../prompts.js';
import { applyClaudeSettings } from '../claude.js';
import { applyCodexConfig } from '../codex.js';
import { applyFigmaMcp, printFigmaResults, printMergeResults } from '../figma.js';
import { templateVars } from '../template-vars.js';
import { MANAGED_TEXT, kitFiles, resolveRoleSkills, readTemplate, render } from '../templates.js';
import { KIT_VERSION } from '../version.js';

export function registerUpdateCommand(program: Command, ctx: CliContext, prompts: Prompts = clackPrompts): void {
  program
    .command('update')
    .description('update kit-owned files to the installed kit version (asks before replacing your edits)')
    .option('--force', 'replace files you edited without asking (a backup is kept)')
    .action(async (opts: { force?: boolean }) => {
      const config = requireConfig(loadProject(ctx));
      const before = readManifest(ctx.cwd)?.kitVersion;
      const isNode = existsSync(join(ctx.cwd, 'package.json'));
      const vars = templateVars(config, {
        kitCmd: isNode ? 'npx tossana-agents' : 'tossana-agents',
        cwd: ctx.cwd,
        packageManager: detectPackageManager(ctx.cwd),
      });
      const relocated = migrateAntigravityAgents(ctx.cwd);
      const results = await applyKitFiles(ctx, kitFiles(config, vars, resolveRoleSkills(ctx.cwd, config)), {
        force: opts.force,
        prompts: ctx.io.interactive ? prompts : null,
        projectSection: render(readTemplate('AGENTS.project.md'), vars, 'AGENTS.project.md'),
      });
      ctx.logger.info(`Kit files ${before && before !== KIT_VERSION ? `v${before} → ` : ''}v${KIT_VERSION}:`);
      printKitFileResults(ctx, results);
      for (const m of relocated) ctx.logger.info(`  moved    ${m}`);
      const moved = migrateDraftsDir(ctx.cwd);
      if (moved) ctx.logger.info(`  moved    ${moved} comment draft(s) from .agents/tmp/ to .tossana/tmp/`);
      printFigmaResults(ctx, applyFigmaMcp(ctx.cwd, config));
      printMergeResults(ctx, applyClaudeSettings(ctx.cwd, config, vars['kit.cmd']!), 'Claude Code');
      printMergeResults(ctx, [applyCodexConfig(ctx.cwd, config, `# ${MANAGED_TEXT(KIT_VERSION)}`)], 'Codex');
    });
}
