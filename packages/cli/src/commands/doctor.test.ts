import { afterEach, describe, expect, it } from 'vitest';
import { writeManifest } from '../kit-manifest.js';
import { KIT_VERSION } from '../version.js';
import {
  CONFIG,
  LIST,
  TOKEN,
  cli,
  fakeApi,
  fakeExec,
  json,
  tempProject,
  type TempProject,
} from '../test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const goodApi = () =>
  fakeApi()
    .on('GET /v2/user', { user: { id: 777, username: 'dara' } })
    .on('GET /v2/list/L1', LIST);

/** A fully set-up project: config, .env, kit files and manifest. */
function readyProject(config: object = { ...CONFIG, commands: { install: 'pnpm install' } }) {
  const p = tempProject({ config });
  p.write('.opencode/agents/orchestrator.md', 'x');
  writeManifest(p.dir, { kitVersion: KIT_VERSION, files: { '.opencode/agents/orchestrator.md': 'abc' } });
  return p;
}

const doctor = (p: TempProject, opts: Parameters<typeof cli>[1] extends infer O ? Partial<O> : never = {}) =>
  cli(['doctor'], { cwd: p.dir, api: goodApi(), ...opts });

const line = (out: string, text: string) => out.split('\n').find((l) => l.includes(text)) ?? '';

describe('doctor', () => {
  it('is all green for a complete setup', async () => {
    project = readyProject();
    const r = await doctor(project);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    for (const ok of [
      'git (git version 2.56.0.windows.1)',
      'git repository',
      'agent.config.json is valid',
      'pnpm 12.10.1',
      '.env exists',
      '.env is git-ignored',
      'ClickUp token in .env',
      'ClickUp token works (user dara, id 777)',
      'CLICKUP_OWNER_USER_ID set (777)',
      'ClickUp list "Mobile" (L1) is accessible',
      'Role statuses exist on the list (to do → coding → in review → testing → Ready for Review)',
      'OpenCode 1.18.35',
      `Kit files present (v${KIT_VERSION})`,
    ]) {
      expect(line(r.out, ok)).toMatch(/^✅ /);
    }
    expect(r.out).toContain('0 failed');
    expect(r.out).not.toContain(TOKEN);
  });

  it('explains a revoked token (OAUTH_025) and skips the checks that need it', async () => {
    project = readyProject();
    const api = fakeApi().on('GET /v2/user', json({ err: 'Token invalid', ECODE: 'OAUTH_025' }, 401));
    const r = await doctor(project, { api });
    expect(r.code).toBe(1);
    expect(line(r.out, 'ClickUp token works')).toMatch(/^❌ /);
    expect(r.out).toContain('FIX: Your ClickUp token is not valid any more (OAUTH_025: token not found)');
    expect(r.out).toContain('Settings → Apps → API Token');
    expect(line(r.out, 'ClickUp list is accessible')).toMatch(/^⏭️ /);
    expect(r.out).toContain('Fix the first failed check');
    expect(r.out).not.toContain(TOKEN);
  });

  it('explains a token that is missing or pasted with quotes, without calling ClickUp', async () => {
    project = readyProject();
    project.write('.env', 'CLICKUP_API_TOKEN=\n');
    const api = goodApi();
    let r = await doctor(project, { api });
    expect(r.out).toContain('FIX: CLICKUP_API_TOKEN is missing in .env');
    expect(api.calls).toHaveLength(0);
    project.write('.env', `CLICKUP_API_TOKEN=" ${TOKEN}"\n`);
    r = await doctor(project, { api });
    expect(r.out).toContain('contains spaces');
  });

  it('hints at a wrong ClickUp account when role statuses are missing', async () => {
    project = readyProject();
    const api = goodApi()
      .on('GET /v2/list/L1', { ...LIST, statuses: LIST.statuses.slice(0, 1) })
      .on('GET /v2/team', { teams: [{ id: '9001', name: 'Dara Test' }] });
    const r = await doctor(project, { api });
    expect(r.code).toBe(1);
    expect(line(r.out, 'Role statuses exist on the list')).toMatch(/^❌ /);
    expect(r.out).toContain(
      'HINT: Check that ClickUp in your browser is logged in to the same account as your token ' +
        '(workspace Dara Test, ID 9001). Changes made in another account or workspace are not visible to this token.',
    );
  });

  it('hints at a wrong ClickUp account when the list is not found (generic if workspaces fail too)', async () => {
    project = readyProject();
    const api = goodApi().on('GET /v2/list/L1', json({ err: 'List not found', ECODE: 'ITEM_015' }, 404));
    const r = await doctor(project, { api });
    expect(line(r.out, 'ClickUp list L1 is accessible')).toMatch(/^❌ /);
    expect(r.out).toContain("same account as your token (the token's workspace (run: tossana-agents clickup spaces))");
    expect(line(r.out, 'Role statuses exist on the list')).toMatch(/^⏭️ /);
  });

  it('does not ask for workspaces when everything is fine', async () => {
    project = readyProject();
    const api = goodApi();
    await doctor(project, { api });
    expect(api.calls.map((c) => c.path)).not.toContain('/v2/team');
  });

  it('fails without agent.config.json and says to run init', async () => {
    project = tempProject({ config: null });
    const r = await doctor(project);
    expect(r.code).toBe(1);
    expect(line(r.out, 'agent.config.json')).toMatch(/^❌ /);
    expect(r.out).toContain('FIX: Run: tossana-agents init');
    expect(r.out).toMatch(/ClickUp list is accessible\n\s+no valid agent\.config\.json/);
  });

  it('shows what is wrong in an invalid config', async () => {
    project = readyProject({ version: 1, project: { name: 'x' } });
    const r = await doctor(project);
    expect(r.out).toContain('project.type');
    expect(r.out).toContain('clickup');
  });

  it('fails when .env is not git-ignored', async () => {
    project = readyProject();
    const r = await doctor(project, { exec: fakeExec({ 'git check-ignore -q .env': { code: 1 } }) });
    expect(line(r.out, '.env is git-ignored')).toMatch(/^❌ /);
    expect(r.out).toContain('Add a line ".env" to .gitignore');
  });

  it('checks .gitignore directly outside a git repo', async () => {
    project = readyProject();
    const exec = fakeExec({ 'git rev-parse --is-inside-work-tree': { code: 128 } });
    let r = await doctor(project, { exec });
    expect(line(r.out, 'git repository')).toMatch(/^❌ /);
    expect(line(r.out, '.env is git-ignored')).toMatch(/^❌ /);
    project.write('.gitignore', 'node_modules\r\n.env\r\n');
    r = await doctor(project, { exec });
    expect(line(r.out, '.env is git-ignored')).toMatch(/^✅ /);
  });

  it('lists missing role statuses and how to add them in ClickUp', async () => {
    project = readyProject();
    const api = goodApi().on('GET /v2/list/L1', { ...LIST, statuses: LIST.statuses.slice(0, 2) });
    const r = await doctor(project, { api });
    expect(r.out).toContain('Missing: review → "in review", testing → "testing", human → "Ready for Review"');
    expect(r.out).toContain('List settings → Statuses');
  });

  it('fails when the final status is a done/closed type in ClickUp', async () => {
    project = readyProject();
    const api = goodApi().on('GET /v2/list/L1', {
      ...LIST,
      statuses: [...LIST.statuses.slice(0, 4), { status: 'Ready for Review', type: 'closed' }],
    });
    const r = await doctor(project, { api });
    expect(line(r.out, 'Final status "Ready for Review" is not a done/closed status')).toMatch(/^❌ /);
  });

  it('explains a list the token cannot open', async () => {
    project = readyProject();
    const api = goodApi().on('GET /v2/list/L1', json({ err: 'Team not authorized', ECODE: 'OAUTH_027' }, 401));
    const r = await doctor(project, { api });
    expect(r.out).toContain('team not authorized');
  });

  it('warns about a missing owner ID and shows the right one', async () => {
    project = readyProject();
    project.write('.env', `CLICKUP_API_TOKEN=${TOKEN}\n`);
    const r = await doctor(project);
    expect(line(r.out, 'CLICKUP_OWNER_USER_ID set')).toMatch(/^⚠️/);
    expect(r.out).toContain('(your id is 777)');
    expect(r.code).toBe(0);
  });

  it('says how to install OpenCode and pnpm', async () => {
    project = readyProject();
    const r = await doctor(project, { exec: fakeExec({ 'opencode --version': null, 'pnpm --version': null }) });
    expect(r.out).toContain('FIX: Install OpenCode: npm install -g opencode-ai');
    expect(r.out).toContain('FIX: Install pnpm: npm install -g pnpm');
  });

  it('checks AGENT_CMD for the custom runner', async () => {
    project = readyProject({ ...CONFIG, pipeline: { runner: 'custom' } });
    const r = await doctor(project);
    expect(r.out).toContain('FIX: Add AGENT_CMD=... to .env');
  });

  it('needs a workspace ID for custom task IDs', async () => {
    project = readyProject({ ...CONFIG, clickup: { ...CONFIG.clickup, customTaskIds: true } });
    const r = await doctor(project);
    expect(r.out).toContain('Set clickup.workspaceId');
  });

  it('asks to update kit files from an older kit version or with missing files', async () => {
    project = readyProject();
    writeManifest(project.dir, { kitVersion: '0.0.1', files: { '.opencode/agents/orchestrator.md': 'abc' } });
    let r = await doctor(project);
    expect(r.out).toContain(`Files are from kit v0.0.1, installed kit is v${KIT_VERSION}.`);
    expect(r.out).toContain('FIX: Run: tossana-agents update');
    writeManifest(project.dir, { kitVersion: KIT_VERSION, files: { '.opencode/agents/coder.md': 'abc' } });
    r = await doctor(project);
    expect(r.out).toContain('Missing: .opencode/agents/coder.md');
  });

  it('uses plain [ OK ]/[FAIL] in the old Windows console, emoji in Windows Terminal', async () => {
    project = readyProject();
    let r = await doctor(project, { platform: 'win32' });
    expect(line(r.out, 'git repository')).toBe('[ OK ] git repository');
    r = await doctor(project, { platform: 'win32', processEnv: { WT_SESSION: 'x' } });
    expect(line(r.out, 'git repository')).toBe('✅ git repository');
  });

  it('warns when git on Windows is not Git for Windows', async () => {
    project = readyProject();
    const r = await doctor(project, {
      platform: 'win32',
      exec: fakeExec({ 'git --version': { code: 0, stdout: 'git version 2.50.0\n' } }),
    });
    expect(r.out).toContain('[WARN] Git for Windows');
  });
});
