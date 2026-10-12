/**
 * `tossana-agents doctor`: checks the whole setup and prints a fix for every problem.
 * Later checks are skipped (not failed) when something they depend on is broken, so the
 * first ❌ is always the one to fix first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  CONFIG_FILE,
  ENV_FILE,
  ROLES,
  canAgentSet,
  clickUpErrorHint,
  isClosedType,
  loadConfig,
  loadEnv,
  statusForRole,
  tokenFormatProblem,
  type AgentConfig,
  type ClickUpList,
  type KitEnv,
} from '@tossana/agents-core';
import { wrongAccountHint } from '../account-hint.js';
import { SilentExit, createClient, type CliContext } from '../context.js';
import { versionOf } from '../exec.js';
import { MANIFEST_PATH, projectPath, readManifest } from '../kit-manifest.js';
import { KIT_VERSION } from '../version.js';

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'skip';

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
  /** Extra advice printed after the fix (e.g. the wrong-account hint). */
  hint?: string;
}

const MIN_NODE_MAJOR = 20;

export function registerDoctorCommand(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('check the setup and show how to fix each problem')
    .action(async () => {
      const checks = await runDoctor(ctx);
      printChecks(ctx, checks);
      if (checks.some((c) => c.status === 'fail')) throw new SilentExit(1);
    });
}

export async function runDoctor(ctx: CliContext): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const run = ctx.exec;

  // ---------- tools ----------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(
    nodeMajor >= MIN_NODE_MAJOR
      ? { name: `Node.js ${process.versions.node}`, status: 'ok' }
      : {
          name: `Node.js ${process.versions.node}`,
          status: 'fail',
          fix: `Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org (LTS).`,
        },
  );

  const gitVersion = versionOf(run, 'git', ctx.cwd);
  add(
    gitVersion
      ? { name: `git (${gitVersion})`, status: 'ok' }
      : {
          name: 'git',
          status: 'fail',
          fix: 'Install Git: https://git-scm.com/downloads (on Windows: Git for Windows).',
        },
  );
  if (ctx.platform === 'win32' && gitVersion && !/windows/i.test(gitVersion)) {
    add({
      name: 'Git for Windows',
      status: 'warn',
      detail: 'git is not Git for Windows (optional).',
      fix: 'Optional: install Git for Windows (https://gitforwindows.org) for Git Bash.',
    });
  }

  const inRepo = gitVersion !== null && run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ctx.cwd }).code === 0;
  if (gitVersion) {
    add(
      inRepo
        ? { name: 'git repository', status: 'ok' }
        : {
            name: 'git repository',
            status: 'fail',
            fix: 'Run "git init" in the project folder (or open the right folder).',
          },
    );
  }

  // ---------- config ----------
  let config: AgentConfig | null = null;
  if (!existsSync(join(ctx.cwd, CONFIG_FILE))) {
    add({ name: CONFIG_FILE, status: 'fail', fix: 'Run: tossana-agents init' });
  } else {
    try {
      config = loadConfig(ctx.cwd);
      add({ name: `${CONFIG_FILE} is valid`, status: 'ok' });
    } catch (e) {
      add({
        name: `${CONFIG_FILE} is valid`,
        status: 'fail',
        detail: (e as Error).message,
        fix: `Fix ${CONFIG_FILE} (see the lines above), or run: tossana-agents init`,
      });
    }
  }

  const pm = packageManagerCheck(ctx, config);
  if (pm) add(pm);

  // ---------- .env and token ----------
  const env: KitEnv = loadEnv(ctx.cwd, ctx.processEnv);
  ctx.logger.addSecret(env.CLICKUP_API_TOKEN);
  const hasEnvFile = existsSync(join(ctx.cwd, ENV_FILE));
  add(
    hasEnvFile
      ? { name: '.env exists', status: 'ok' }
      : { name: '.env exists', status: 'fail', fix: 'Create .env (copy .env.example) or run: tossana-agents init' },
  );
  add(envIgnoredCheck(ctx, inRepo));

  const tokenProblem = tokenFormatProblem(env.CLICKUP_API_TOKEN);
  add(
    tokenProblem
      ? { name: 'ClickUp token in .env', status: 'fail', fix: tokenProblem }
      : { name: 'ClickUp token in .env', status: 'ok' },
  );

  const owner = env.CLICKUP_OWNER_USER_ID;
  const ownerOk = !!owner && /^\d+$/.test(owner.trim());

  // ---------- ClickUp ----------
  const skipped = (name: string, why: string): Check => ({ name, status: 'skip', detail: why });
  let tokenWorks = false;
  let me: { id: number; username: string | null } | null = null;
  if (config?.clickup.customTaskIds && !(env.CLICKUP_WORKSPACE_ID || config.clickup.workspaceId)) {
    add({
      name: 'Workspace ID for custom task IDs',
      status: 'fail',
      fix: `Set clickup.workspaceId in ${CONFIG_FILE} (the first number in any ClickUp URL).`,
    });
  }
  // Doctor only reads the user and the list, so custom task IDs do not matter here.
  const client = tokenProblem ? null : createClient(ctx, { config, env: { ...env, CLICKUP_CUSTOM_TASK_IDS: 'false' } });
  if (!client) {
    add(skipped('ClickUp token works', 'no valid token'));
  } else {
    try {
      me = await client.getUser();
      tokenWorks = true;
      add({ name: `ClickUp token works (user ${me.username ?? '?'}, id ${me.id})`, status: 'ok' });
    } catch (e) {
      add({
        name: 'ClickUp token works',
        status: 'fail',
        detail: (e as Error).message,
        fix: clickUpErrorHint(e) ?? 'Check your internet connection and the token, then run doctor again.',
      });
    }
  }

  add(
    ownerOk
      ? {
          name: `CLICKUP_OWNER_USER_ID set (${owner!.trim()})`,
          status: 'ok',
          detail:
            me && String(me.id) !== owner!.trim()
              ? `Note: the token belongs to user ${me.id}, notifications go to ${owner!.trim()}.`
              : undefined,
        }
      : {
          name: 'CLICKUP_OWNER_USER_ID set',
          status: 'warn',
          detail: 'Needed for "notify" (the owner gets the Ready for Review notification).',
          fix: `Add CLICKUP_OWNER_USER_ID=<your user id> to .env${me ? ` (your id is ${me.id})` : ' (run: tossana-agents clickup spaces)'}.`,
        },
  );

  let list: ClickUpList | null = null;
  if (!config || !client || !tokenWorks) {
    add(skipped('ClickUp list is accessible', !config ? `no valid ${CONFIG_FILE}` : 'token does not work'));
  } else {
    try {
      list = await client.getList(config.clickup.listId);
      add({ name: `ClickUp list "${list.name}" (${list.id}) is accessible`, status: 'ok' });
    } catch (e) {
      add({
        name: `ClickUp list ${config.clickup.listId} is accessible`,
        status: 'fail',
        detail: (e as Error).message,
        fix:
          clickUpErrorHint(e) ??
          `Check clickup.listId in ${CONFIG_FILE}. Find list IDs with: tossana-agents clickup lists`,
        hint: await wrongAccountHint(client),
      });
    }
  }

  if (!config || !list) {
    add(skipped('Role statuses exist on the list', 'list not available'));
  } else {
    const listChecks = statusChecks(config, list);
    const missing = listChecks.find((c) => c.name === MISSING_STATUSES && c.status === 'fail');
    if (missing) missing.hint = await wrongAccountHint(client!);
    checks.push(...listChecks);
  }

  // ---------- runner ----------
  if (config) add(runnerCheck(ctx, config, env));

  // ---------- kit files ----------
  add(kitFilesCheck(ctx));

  return checks;
}

function packageManagerCheck(ctx: CliContext, config: AgentConfig | null): Check | null {
  const install = config?.commands.install?.trim();
  const pm = install?.split(/\s+/)[0];
  if (!pm || !['pnpm', 'npm', 'yarn', 'bun'].includes(pm)) {
    const npm = versionOf(ctx.exec, 'npm', ctx.cwd);
    return npm
      ? { name: `npm ${npm}`, status: 'ok' }
      : { name: 'npm', status: 'warn', fix: 'npm comes with Node.js; reinstall Node.js if it is missing.' };
  }
  const version = versionOf(ctx.exec, pm, ctx.cwd);
  return version
    ? { name: `${pm} ${version}`, status: 'ok' }
    : { name: pm, status: 'fail', fix: pm === 'npm' ? 'Reinstall Node.js.' : `Install ${pm}: npm install -g ${pm}` };
}

function envIgnoredCheck(ctx: CliContext, inRepo: boolean): Check {
  const name = '.env is git-ignored';
  const fix =
    'Add a line ".env" to .gitignore (tokens must never be committed). Running tossana-agents init does this.';
  if (inRepo) {
    const res = ctx.exec('git', ['check-ignore', '-q', ENV_FILE], { cwd: ctx.cwd });
    return res.code === 0 ? { name, status: 'ok' } : { name, status: 'fail', fix };
  }
  const gitignore = join(ctx.cwd, '.gitignore');
  const lines = existsSync(gitignore)
    ? readFileSync(gitignore, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
    : [];
  return lines.some((l) => ['.env', '/.env', '.env*', '*.env'].includes(l))
    ? { name, status: 'ok' }
    : { name, status: 'fail', fix };
}

const MISSING_STATUSES = 'Role statuses exist on the list';

function statusChecks(config: AgentConfig, list: ClickUpList): Check[] {
  const checks: Check[] = [];
  const statuses = list.statuses ?? [];
  const allowed = ROLES.map((r) => statusForRole(config, r));
  const missing: string[] = [];
  for (const role of ROLES) {
    const name = statusForRole(config, role);
    const match = statuses.find((s) => s.status.trim().toLowerCase() === name.trim().toLowerCase());
    if (!match) {
      missing.push(`${role} → "${name}"`);
    } else if (role === 'human' && isClosedType(match.type)) {
      checks.push({
        name: `Final status "${match.status}" is not a done/closed status`,
        status: 'fail',
        detail: `Its ClickUp type is "${match.type}", so agents could never set it.`,
        fix: `In ClickUp, move "${match.status}" out of the Done/Closed group of the list's statuses, or map clickup.statuses.human to another status.`,
      });
    } else if (!canAgentSet(match, allowed)) {
      checks.push({
        name: `Status "${match.status}" can be set by agents`,
        status: 'fail',
        fix: 'Use a status that is not done/closed.',
      });
    }
  }
  if (missing.length) {
    checks.unshift({
      name: MISSING_STATUSES,
      status: 'fail',
      detail: `Missing: ${missing.join(', ')}`,
      fix:
        `In ClickUp open the list → ⋯ → List settings → Statuses, add the missing statuses (exact names), ` +
        `or change clickup.statuses in ${CONFIG_FILE} to match. Show the list's statuses: tossana-agents clickup statuses`,
    });
  } else {
    checks.unshift({ name: `Role statuses exist on the list (${allowed.join(' → ')})`, status: 'ok' });
  }
  return checks;
}

function runnerCheck(ctx: CliContext, config: AgentConfig, env: KitEnv): Check {
  const runner = config.pipeline.runner;
  if (runner === 'opencode') {
    const v = versionOf(ctx.exec, 'opencode', ctx.cwd);
    return v
      ? { name: `OpenCode ${v}`, status: 'ok' }
      : {
          name: 'OpenCode installed',
          status: 'fail',
          fix: 'Install OpenCode: npm install -g opencode-ai  (then log in to your model provider: opencode auth login)',
        };
  }
  if (runner === 'custom') {
    return env.AGENT_CMD?.trim()
      ? { name: 'AGENT_CMD set for the custom runner', status: 'ok' }
      : {
          name: 'AGENT_CMD set for the custom runner',
          status: 'fail',
          fix: 'Add AGENT_CMD=... to .env, with {agent} and {prompt} placeholders.',
        };
  }
  return { name: `Runner "${runner}"`, status: 'ok', detail: 'No headless runner; use /start-task in the IDE.' };
}

function kitFilesCheck(ctx: CliContext): Check {
  const name = 'Kit files present and up to date';
  const manifest = readManifest(ctx.cwd);
  if (!manifest)
    return { name, status: 'fail', detail: `${MANIFEST_PATH} not found.`, fix: 'Run: tossana-agents init' };
  const missing = Object.keys(manifest.files).filter((f) => !existsSync(projectPath(ctx.cwd, f)));
  if (missing.length) {
    return { name, status: 'fail', detail: `Missing: ${missing.join(', ')}`, fix: 'Run: tossana-agents update' };
  }
  if (manifest.kitVersion !== KIT_VERSION) {
    return {
      name,
      status: 'fail',
      detail: `Files are from kit v${manifest.kitVersion}, installed kit is v${KIT_VERSION}.`,
      fix: 'Run: tossana-agents update',
    };
  }
  return { name: `Kit files present (v${KIT_VERSION})`, status: 'ok' };
}

// ---------- output ----------

/** The old Windows console (conhost) cannot show emoji; Windows Terminal and VS Code can. */
export function useUnicode(ctx: CliContext): boolean {
  if (ctx.platform !== 'win32') return true;
  const env = ctx.processEnv;
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.TERM?.includes('xterm'));
}

export function printChecks(ctx: CliContext, checks: Check[]): void {
  const icons = useUnicode(ctx)
    ? { ok: '✅', fail: '❌', warn: '⚠️ ', skip: '⏭️ ' }
    : { ok: '[ OK ]', fail: '[FAIL]', warn: '[WARN]', skip: '[SKIP]' };
  const print = (s: string) => ctx.logger.info(s);
  print(`tossana-agents doctor (v${KIT_VERSION}) in ${ctx.cwd}\n`);
  for (const c of checks) {
    print(`${icons[c.status]} ${c.name}`);
    if (c.detail) for (const line of c.detail.split('\n')) print(`       ${line}`);
    if (c.fix && c.status !== 'ok') print(`       FIX: ${c.fix}`);
    if (c.hint && c.status !== 'ok') print(`       HINT: ${c.hint}`);
  }
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  print(`\n${count('ok')} ok, ${count('fail')} failed, ${count('warn')} warnings, ${count('skip')} skipped`);
  if (count('fail')) print('Fix the first failed check, then run: tossana-agents doctor');
}
