/**
 * `tossana-agents ui`: starts the Local Console for this project and opens it in the browser.
 * Runs until Ctrl+C; a run that is still going is stopped (whole process tree) before the console exits.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { KitError } from '@tossana/agents-core';
import type { CliContext } from '../context.js';
import { ConsoleApp } from './app.js';
import { startConsoleServer } from './server.js';

/** The built page (dist/console.html, next to the bundled CLI; see scripts/postbuild.mjs). */
export function loadConsoleHtml(): string {
  try {
    return readFileSync(new URL('./console.html', import.meta.url), 'utf8');
  } catch {
    throw new KitError('the Local Console page is missing from this install (dist/console.html). Run: pnpm build');
  }
}

/** Opens a URL in the default browser. Plain argv, no shell (the URL contains & and ?). */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] =
    platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {}); // no browser: the URL is printed anyway
    child.unref();
  } catch {
    // same
  }
}

export function registerUiCommand(program: Command, ctx: CliContext): void {
  program
    .command('ui')
    .description('open the Local Console in your browser (this project only, on this machine only)')
    .option('--no-open', 'print the URL but do not open the browser')
    .action(async (opts: { open?: boolean }) => {
      const server = await startConsoleServer({ app: new ConsoleApp(ctx), html: loadConsoleHtml() });
      ctx.logger.info(`Local Console for ${ctx.cwd}`);
      ctx.logger.info(`  ${server.url}`);
      ctx.logger.info('  Only this machine can open it; the link works until you stop the console. Ctrl+C to stop.');
      if (opts.open !== false) openBrowser(server.url);
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      ctx.logger.info('Stopping the Local Console…');
      await server.close();
    });
}
