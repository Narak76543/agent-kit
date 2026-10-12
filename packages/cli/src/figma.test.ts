import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '@tossana/agents-core';
import { ANTIGRAVITY_MCP_CONFIG, OPENCODE_CONFIG, applyFigmaMcp, figmaChecks } from './figma.js';
import { CONFIG, LIST, TOKEN, cli, fakeApi, tempProject, type TempProject } from './test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const config = (figma: object) => parseConfig({ ...CONFIG, figma });
const readJson = (file: string) => JSON.parse(readFileSync(join(project.dir, ...file.split('/')), 'utf8'));
const read = (file: string) => readFileSync(join(project.dir, ...file.split('/')), 'utf8');

describe('applyFigmaMcp', () => {
  it('adds the desktop server to both configs and keeps the user settings in them', () => {
    project = tempProject();
    project.write(OPENCODE_CONFIG, { model: 'my/model', mcp: { other: { type: 'local', command: ['x'] } } });
    const results = applyFigmaMcp(project.dir, config({ enabled: true }));
    expect(results.map((r) => r.action)).toEqual(['added', 'added']);
    expect(readJson(OPENCODE_CONFIG)).toEqual({
      model: 'my/model',
      mcp: {
        other: { type: 'local', command: ['x'] },
        figma: { type: 'remote', url: 'http://127.0.0.1:3845/mcp', enabled: true, oauth: false },
      },
    });
    expect(readJson(ANTIGRAVITY_MCP_CONFIG)).toEqual({
      mcpServers: { figma: { serverUrl: 'http://127.0.0.1:3845/mcp' } },
    });
    expect(applyFigmaMcp(project.dir, config({ enabled: true })).map((r) => r.action)).toEqual([
      'unchanged',
      'unchanged',
    ]);
  });

  it('switches to the remote server (OAuth, no token stored) and removes only its own entry when disabled', () => {
    project = tempProject();
    applyFigmaMcp(project.dir, config({ enabled: true }));
    expect(applyFigmaMcp(project.dir, config({ enabled: true, server: 'remote' })).map((r) => r.action)).toEqual([
      'updated',
      'updated',
    ]);
    expect(readJson(OPENCODE_CONFIG).mcp.figma).toEqual({
      type: 'remote',
      url: 'https://mcp.figma.com/mcp',
      enabled: true,
    });
    expect(read(OPENCODE_CONFIG)).not.toMatch(/token|Authorization/i);

    applyFigmaMcp(project.dir, config({ enabled: false }));
    expect(readJson(OPENCODE_CONFIG)).toEqual({ $schema: 'https://opencode.ai/config.json', mcp: {} });
    expect(readJson(ANTIGRAVITY_MCP_CONFIG)).toEqual({ mcpServers: {} });
  });

  it('leaves a figma server the user set up differently, and never creates files when disabled', () => {
    project = tempProject();
    expect(applyFigmaMcp(project.dir, config({ enabled: false })).map((r) => r.action)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect(existsSync(join(project.dir, OPENCODE_CONFIG))).toBe(false);
    project.write(OPENCODE_CONFIG, { mcp: { figma: { type: 'local', command: ['my-figma'] } } });
    applyFigmaMcp(project.dir, config({ enabled: false }));
    expect(readJson(OPENCODE_CONFIG).mcp.figma).toEqual({ type: 'local', command: ['my-figma'] });
  });

  it('does not touch a JSONC file and says what to add by hand', () => {
    project = tempProject();
    project.write(OPENCODE_CONFIG, '{\n  // my settings\n  "model": "x"\n}\n');
    const [opencode] = applyFigmaMcp(project.dir, config({ enabled: true }));
    expect(opencode!.action).toBe('manual');
    expect(opencode!.hint).toContain('"figma": {"type":"remote","url":"http://127.0.0.1:3845/mcp"');
    expect(read(OPENCODE_CONFIG)).toContain('// my settings');
  });
});

describe('init and doctor with Figma', () => {
  const api = () =>
    fakeApi()
      .on('GET /v2/user', { user: { id: 777, username: 'dara' } })
      .on('GET /v2/list/L1', LIST);

  function webProject() {
    const p = tempProject({ config: null, env: `CLICKUP_API_TOKEN=${TOKEN}\n` });
    p.write('package.json', { name: 'web', dependencies: { next: '16.0.0', react: '19.0.0' } });
    return p;
  }

  it('init --figma configures both tools and gives only the coder and reviewer read-only Figma tools', async () => {
    project = webProject();
    const r = await cli(['init', '--yes', '--list', 'L1', '--no-doctor', '--figma'], { cwd: project.dir, api: api() });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`added    ${OPENCODE_CONFIG} (Figma MCP server)`);
    expect(readJson('agent.config.json').figma).toEqual({ enabled: true });
    expect(readJson(ANTIGRAVITY_MCP_CONFIG).mcpServers.figma.serverUrl).toBe('http://127.0.0.1:3845/mcp');

    const perms = (agent: string) =>
      (parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(read(`.opencode/agents/${agent}.md`))![1]!) as { permission: object })
        .permission;
    for (const agent of ['coder', 'reviewer']) {
      expect(perms(agent)).toMatchObject({ figma_get_design_context: 'allow', figma_get_variable_defs: 'allow' });
      expect(Object.keys(perms(agent)).filter((k) => k.startsWith('figma_'))).not.toContain('figma_use_figma');
    }
    expect(Object.keys(perms('tester')).some((k) => k.startsWith('figma_'))).toBe(false);
    expect(Object.keys(perms('orchestrator')).some((k) => k.startsWith('figma_'))).toBe(false);

    expect(read('.opencode/agents/orchestrator.md')).toContain('`Figma: <links>`');
    expect(read('.opencode/agents/coder.md')).toContain('read each frame **once per task**');
    expect(read('.opencode/agents/reviewer.md')).toContain('Figma: <expected>, code: <actual>');
    expect(read('.agents/skills/start-task/SKILL.md')).toContain('`npx tossana-agents clickup handoff <taskId>');
  });

  it('init --yes without --figma adds no Figma text, permissions or config files', async () => {
    project = webProject();
    await cli(['init', '--yes', '--list', 'L1', '--no-doctor'], { cwd: project.dir, api: api() });
    expect(readJson('agent.config.json').figma).toEqual({ enabled: false });
    expect(existsSync(join(project.dir, OPENCODE_CONFIG))).toBe(false);
    expect(existsSync(join(project.dir, ANTIGRAVITY_MCP_CONFIG))).toBe(false);
    for (const agent of ['orchestrator', 'coder', 'reviewer']) {
      expect(read(`.opencode/agents/${agent}.md`)).not.toMatch(/figma/i);
    }
    expect(read('.agents/skills/start-task/SKILL.md')).not.toMatch(/figma/i);
  });

  it('doctor checks both configs, the desktop server and prints the seat note', async () => {
    project = tempProject({ config: { ...CONFIG, figma: { enabled: true } } });
    const down = async () => {
      throw new Error('ECONNREFUSED');
    };
    let checks = await figmaChecks(project.dir, config({ enabled: true }), down);
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      [`Figma MCP server in ${OPENCODE_CONFIG}`, 'fail'],
      [`Figma MCP server in ${ANTIGRAVITY_MCP_CONFIG}`, 'fail'],
      ['Figma desktop MCP server is running (http://127.0.0.1:3845/mcp)', 'warn'],
      ['Figma seats', 'ok'],
    ]);
    expect(checks[3]!.detail).toContain('View and Collab seats get only 20 Figma MCP calls per month');

    applyFigmaMcp(project.dir, config({ enabled: true }));
    checks = await figmaChecks(project.dir, config({ enabled: true }), async () => new Response('', { status: 400 }));
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(await figmaChecks(project.dir, config({ enabled: false }), down)).toEqual([]);
  });
});
