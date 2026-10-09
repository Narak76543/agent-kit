/** Runs the CLI in-process against a fake ClickUp API and a temp project folder. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeApi, type FakeApi } from '../../core/src/clickup/fake-api.test-helper.js';
import { runCli } from './program.js';

export { fakeApi, json } from '../../core/src/clickup/fake-api.test-helper.js';

export const TOKEN = 'pk_12345678_TESTTOKENTESTTOKENTESTTOKEN';

export const CONFIG = {
  version: 1,
  project: { name: 'Demo App', type: 'react-native', skill: 'mobile-master' },
  clickup: {
    listId: 'L1',
    statuses: { todo: 'to do', coding: 'coding', review: 'in review', testing: 'testing', human: 'Ready for Review' },
  },
};

export const LIST = {
  id: 'L1',
  name: 'Mobile',
  statuses: [
    { status: 'to do', type: 'open' },
    { status: 'coding', type: 'custom' },
    { status: 'in review', type: 'custom' },
    { status: 'testing', type: 'custom' },
    { status: 'Ready for Review', type: 'custom' },
    { status: 'complete', type: 'closed' },
  ],
};

export interface TempProject {
  dir: string;
  write(file: string, content: string | object): void;
  cleanup(): void;
}

/** A temp folder whose path contains spaces, like many Windows user folders. */
export function tempProject(options: { config?: object | null; env?: string | null } = {}): TempProject {
  const root = mkdtempSync(join(tmpdir(), 'tak cli '));
  const dir = join(root, 'My Project');
  mkdirSync(dir);
  const project: TempProject = {
    dir,
    write(file, content) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  if (options.config !== null) project.write('agent.config.json', options.config ?? CONFIG);
  if (options.env !== null)
    project.write('.env', options.env ?? `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\n`);
  return project;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

export async function cli(
  args: string[],
  opts: { cwd: string; api?: FakeApi; stdin?: string; processEnv?: Record<string, string>; interactive?: boolean },
): Promise<CliResult> {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    cwd: opts.cwd,
    processEnv: opts.processEnv ?? {},
    fetch: (opts.api ?? fakeApi()).fetch,
    now: () => new Date('2026-10-09T12:00:00Z'),
    io: {
      out: (t) => (out += t),
      err: (t) => (err += t),
      readStdin: async () => opts.stdin ?? '',
      interactive: opts.interactive ?? false,
    },
  });
  return { code, out, err };
}
