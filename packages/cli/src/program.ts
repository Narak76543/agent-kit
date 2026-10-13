import { resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import { DoneGuardError, KitError, clickUpErrorHint } from '@tossana/agents-core';
import { registerAgentsCommand } from './commands/agents.js';
import { registerAntigravityCommand } from './commands/antigravity.js';
import { registerClickupCommands } from './commands/clickup.js';
import { registerContextCommand } from './commands/task-context-cmd.js';
import { registerReviewCommands } from './commands/review.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerGuardCommand } from './commands/guard.js';
import { registerInitCommand } from './commands/init.js';
import { registerRunCommand } from './commands/run.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerUiCommand } from './console/command.js';
import { SilentExit, createContext, type CliContext } from './context.js';
import { KIT_VERSION } from './version.js';

export type ContextOptions = Parameters<typeof createContext>[0];

export function createProgram(ctx: CliContext): Command {
  const program = new Command('tossana-agents')
    .description('Multi-agent coding workflow driven by ClickUp tasks')
    .version(KIT_VERSION, '-v, --version')
    .option('--cwd <path>', 'project folder (default: current folder)')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (s) => ctx.io.out(s), writeErr: (s) => ctx.io.err(s) })
    .hook('preAction', (thisCommand) => {
      const cwd = thisCommand.opts<{ cwd?: string }>().cwd;
      if (cwd) ctx.cwd = resolve(ctx.cwd, cwd);
    });

  registerAgentsCommand(program, ctx, ctx.prompts);
  registerAntigravityCommand(program, ctx, ctx.prompts);
  registerClickupCommands(program, ctx);
  registerContextCommand(program, ctx);
  registerReviewCommands(program, ctx, ctx.prompts);
  registerWatchCommand(program, ctx);
  registerDoctorCommand(program, ctx);
  registerGuardCommand(program, ctx);
  registerInitCommand(program, ctx, ctx.prompts);
  registerRunCommand(program, ctx);
  registerUpdateCommand(program, ctx, ctx.prompts);
  registerUiCommand(program, ctx);

  // Subcommands share the parent's output and exit behaviour.
  const inherit = (cmd: Command) => {
    for (const sub of cmd.commands) {
      sub.exitOverride().configureOutput({ writeOut: (s) => ctx.io.out(s), writeErr: (s) => ctx.io.err(s) });
      inherit(sub);
    }
  };
  inherit(program);
  return program;
}

/**
 * Runs the CLI and resolves with the exit code. Never calls process.exit(): exiting while
 * fetch sockets are still closing crashes Node on Windows (libuv UV_HANDLE_CLOSING assertion),
 * so the caller sets process.exitCode instead (fix kept from EKMONG_MOBILE scripts/clickup.ts).
 */
export async function runCli(argv: string[], options: ContextOptions = {}): Promise<number> {
  const ctx = createContext(options);
  try {
    await createProgram(ctx).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    return reportError(ctx, e);
  }
}

function reportError(ctx: CliContext, e: unknown): number {
  if (e instanceof SilentExit) return e.exitCode;
  if (e instanceof CommanderError) {
    // Commander already printed the message (or help/version).
    return e.exitCode;
  }
  if (e instanceof DoneGuardError) {
    ctx.logger.error(e.message);
    return e.exitCode;
  }
  if (e instanceof KitError) {
    ctx.logger.error(`ERROR: ${e.message}`);
    const hint = clickUpErrorHint(e);
    if (hint) ctx.logger.error(`FIX: ${hint}`);
    return e.exitCode;
  }
  ctx.logger.error(`ERROR: ${(e as Error)?.stack ?? String(e)}`);
  return 1;
}
