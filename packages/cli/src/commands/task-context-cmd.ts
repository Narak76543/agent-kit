/**
 * `tossana-agents context <taskId> [--no-docs]`: refresh the ClickUp context by hand (run and resume do it before the
 * agent starts): ClickUp Docs into docs/clickup/ and the task bundle into .agents/context/<taskId>/.
 */
import type { Command } from 'commander';
import { createClient, loadProject, type CliContext } from '../context.js';
import { refreshContext, refreshTaskContext } from '../task-context.js';

export function registerContextCommand(program: Command, ctx: CliContext): void {
  program
    .command('context <taskId>')
    .description(
      'refresh the ClickUp context the agents read: docs, task, parent, subtasks, links, comments, attachments',
    )
    .option('--no-docs', 'only the task bundle, not the ClickUp Docs')
    .action(async (taskId: string, opts: { docs?: boolean }) => {
      const project = loadProject(ctx);
      const client = createClient(ctx, project);
      const log = (s: string) => ctx.logger.info(s);
      if (opts.docs === false) {
        const r = await refreshTaskContext(ctx.cwd, client, taskId, null);
        log(`[context] task: ${r.files.join(', ')} in ${r.dir.replace(/\\/g, '/')}/`);
      } else {
        await refreshContext(ctx.cwd, project.config, project.env, client, taskId, log);
      }
    });
}
