/**
 * `tossana-agents update`: brings kit-owned files up to the installed kit version. Files you edited
 * are shown as a diff and only replaced after you confirm (or with --force; a backup is kept).
 * Project-owned files (.env, the AGENTS.md project section, your skills) are never touched. In agent.config.json only
 * "agents" can change: a role still on the kit's last defaults gets the new defaults; edited roles are kept.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { CONFIG_FILE, detectPackageManager } from '@tossana/agents-core';
import {
  migrateConfigFile,
  printSkillChanges,
  readRawConfig,
  reconcileAgentSkills,
  recordAgentDefaults,
  writeRawConfig,
} from '../agent-skills.js';
import { loadProject, requireConfig, type CliContext } from '../context.js';
import { ensureGitignore } from './init.js';
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
    .action((opts: { force?: boolean }) => updateProject(ctx, { force: opts.force, prompts }));
}

/** Everything `update` does; also used after editing agent skills, so the agent files follow at once. */
export async function updateProject(
  ctx: CliContext,
  opts: { force?: boolean; prompts?: Prompts | null },
): Promise<void> {
  const log = (s: string) => ctx.logger.info(s);
  const migrated = migrateConfigFile(ctx.cwd);
  if (migrated) log(migrated);
  if (!existsSync(join(ctx.cwd, CONFIG_FILE))) requireConfig(loadProject(ctx)); // "not found. Run: tossana-agents init"

  // Agent skills: new kit defaults only for roles nobody edited.
  const before = readManifest(ctx.cwd);
  const raw = readRawConfig(ctx.cwd);
  const skills = reconcileAgentSkills(raw, before?.agentDefaults ?? null);
  if (skills.agents && JSON.stringify(raw.agents) !== JSON.stringify(toAgentsSection(skills.agents))) {
    raw.agents = toAgentsSection(skills.agents);
    writeRawConfig(ctx.cwd, raw);
  }

  const config = requireConfig(loadProject(ctx));
  const isNode = existsSync(join(ctx.cwd, 'package.json'));
  const vars = templateVars(config, {
    kitCmd: isNode ? 'npx tossana-agents' : 'tossana-agents',
    cwd: ctx.cwd,
    packageManager: detectPackageManager(ctx.cwd),
  });
  const relocated = migrateAntigravityAgents(ctx.cwd);
  const results = await applyKitFiles(ctx, kitFiles(config, vars, resolveRoleSkills(ctx.cwd, config)), {
    force: opts.force,
    prompts: ctx.io.interactive ? (opts.prompts ?? clackPrompts) : null,
    projectSection: render(readTemplate('AGENTS.project.md'), vars, 'AGENTS.project.md'),
  });
  recordAgentDefaults(ctx.cwd, skills.defaults);
  printSkillChanges(ctx, skills.changes);
  const version = before?.kitVersion;
  log(`Kit files ${version && version !== KIT_VERSION ? `v${version} → ` : ''}v${KIT_VERSION}:`);
  printKitFileResults(ctx, results);
  for (const m of relocated) log(`  moved    ${m}`);
  // New kit versions may ignore more local files (e.g. .agents/context/): add the missing lines.
  if (ensureGitignore(ctx.cwd)) log('  updated  .gitignore');
  const moved = migrateDraftsDir(ctx.cwd);
  if (moved) log(`  moved    ${moved} comment draft(s) from .agents/tmp/ to .tossana/tmp/`);
  printFigmaResults(ctx, applyFigmaMcp(ctx.cwd, config));
  printMergeResults(ctx, applyClaudeSettings(ctx.cwd, config, vars['kit.cmd']!), 'Claude Code');
  printMergeResults(ctx, [applyCodexConfig(ctx.cwd, config, `# ${MANAGED_TEXT(KIT_VERSION)}`)], 'Codex');
}

/** agent.config.json form: { "coder": { "skills": [...] }, … } */
export const toAgentsSection = (skills: Record<'coder' | 'reviewer' | 'tester', string[]>) => ({
  coder: { skills: skills.coder },
  reviewer: { skills: skills.reviewer },
  tester: { skills: skills.tester },
});
