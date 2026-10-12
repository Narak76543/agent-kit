import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@tossana/agents-core';
import { CODEX_CONFIG, CODEX_RULES, applyCodexConfig, codexTrusted, tomlString } from './codex.js';
import { codexAdapter } from './runners.js';
import {
  CONFIG,
  LIST,
  TOKEN,
  cli,
  fakeApi,
  fakeExec,
  tempProject,
  type TempProject,
} from './test-utils.test-helper.js';

let project: TempProject;
afterEach(() => project?.cleanup());

const read = (file: string) => readFileSync(join(project.dir, ...file.split('/')), 'utf8');
const api = () =>
  fakeApi()
    .on('GET /v2/user', { user: { id: 777, username: 'dara' } })
    .on('GET /v2/list/L1', LIST);
const HEADER = '# Managed by @tossana/agents v0 — do not edit; run "tossana-agents update"';

function nodeProject() {
  const p = tempProject({ config: null, env: `CLICKUP_API_TOKEN=${TOKEN}\n` });
  p.write('package.json', {
    name: 'api',
    dependencies: { express: '5' },
    scripts: { lint: 'eslint .', test: 'vitest run' },
  });
  p.write('pnpm-lock.yaml', '');
  return p;
}

describe('Codex files', () => {
  it('init --tools codex writes one TOML agent per role, the orchestrator instructions, rules and config', async () => {
    project = nodeProject();
    const r = await cli(['init', '--yes', '--list', 'L1', '--no-doctor', '--tools', 'codex', '--figma'], {
      cwd: project.dir,
      api: api(),
    });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(join(project.dir, '.opencode'))).toBe(false);

    const coder = read('.codex/agents/coder.toml');
    expect(coder).toContain('name = "coder"');
    expect(coder).toContain('sandbox_mode = "workspace-write"');
    expect(coder).toMatch(/developer_instructions = '''\n> Codex: you run in the workspace-write sandbox/);
    expect(coder).toContain('You are the **coder**');
    expect(read('.codex/agents/reviewer.toml')).toContain('sandbox_mode = "read-only"');
    expect(read('.codex/orchestrator.md')).toContain('`reviewer` run in a read-only sandbox and cannot write');

    const rules = read(CODEX_RULES);
    expect(rules).toContain('pattern = ["git", "push"],\n    decision = "forbidden"');
    expect(rules).toContain('pattern = ["git", ["add", "commit"]],\n    decision = "allow"');
    expect(rules).toContain('pattern = ["pnpm", "install"]');

    expect(read(CODEX_CONFIG)).toContain('approval_policy = "never"\nsandbox_mode = "workspace-write"');
    expect(read(CODEX_CONFIG)).toContain('[mcp_servers.figma]\nurl = "http://127.0.0.1:3845/mcp"');
    // Codex keeps .agents/ read-only in its sandbox: drafts live in .tossana/tmp/.
    expect(read('.codex/orchestrator.md')).toContain('.tossana/tmp/<taskId>-<role>.md');
  });

  it("never changes the user's own .codex/config.toml; updates the kit's own one", () => {
    project = tempProject();
    const config = parseConfig({ ...CONFIG, tools: ['codex'] });
    project.write(CODEX_CONFIG, 'model = "gpt-5"\n');
    const r = applyCodexConfig(project.dir, config, HEADER);
    expect(r.action).toBe('manual');
    expect(r.hint).toContain('approval_policy = "never"');
    expect(read(CODEX_CONFIG)).toBe('model = "gpt-5"\n');

    project.write(CODEX_CONFIG, `${HEADER}\nold\n`);
    expect(applyCodexConfig(project.dir, config, HEADER).action).toBe('updated');
    expect(applyCodexConfig(project.dir, config, HEADER).action).toBe('unchanged');
    expect(applyCodexConfig(project.dir, parseConfig(CONFIG), HEADER).action).toBe('unchanged');
  });

  it('writes TOML strings safely', () => {
    expect(tomlString('one line "quoted"')).toBe('"one line \\"quoted\\""');
    expect(tomlString('a\nb\n')).toBe("'''\na\nb\n'''");
    expect(tomlString("has ''' inside\n")).toBe("\"has ''' inside\\n\"");
  });

  it('reads project trust from ~/.codex/config.toml (Windows paths too)', () => {
    project = tempProject();
    const home = join(project.dir, 'codex-home');
    mkdirSync(home);
    expect(codexTrusted(project.dir, home)).toBe(false);
    const escaped = project.dir.replace(/\\/g, '\\\\');
    writeFileSync(join(home, 'config.toml'), `model = "x"\n\n[projects."${escaped}"]\ntrust_level = "trusted"\n`);
    expect(codexTrusted(project.dir, home)).toBe(true);
    writeFileSync(join(home, 'config.toml'), `[projects."${escaped}"]\ntrust_level = "untrusted"\n`);
    expect(codexTrusted(project.dir, home)).toBe(false);
  });

  it('runs codex exec in workspace-write, never asking, pointed at the orchestrator instructions', () => {
    expect(
      codexAdapter(fakeExec(), '.').buildCommand({ agent: 'orchestrator', prompt: 'Work on T1.', cwd: '.' }),
    ).toEqual({
      cmd: 'codex',
      args: [
        'exec',
        '--sandbox',
        'workspace-write',
        '-c',
        'approval_policy=never',
        'Work on T1. You are the orchestrator: read .codex/orchestrator.md and follow it exactly.',
      ],
    });
  });

  it('doctor fails until Codex trusts the project', async () => {
    project = tempProject({ config: { ...CONFIG, tools: ['codex'] } });
    const home = join(project.dir, 'codex-home');
    mkdirSync(home);
    project.write('.env', `CLICKUP_API_TOKEN=${TOKEN}\nCLICKUP_OWNER_USER_ID=777\nCODEX_HOME=${home}\n`);
    let r = await cli(['doctor'], { cwd: project.dir, api: api() });
    expect(r.out).toMatch(/❌ Codex trusts this project/);
    writeFileSync(join(home, 'config.toml'), `[projects.'${project.dir}']\ntrust_level = "trusted"\n`);
    r = await cli(['doctor'], { cwd: project.dir, api: api() });
    expect(r.out).toMatch(/✅ Codex trusts this project/);
  });
});
