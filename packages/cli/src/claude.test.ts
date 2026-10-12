import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseConfig } from '@tossana/agents-core';
import { applyClaudeSettings, CLAUDE_RUN_SETTINGS } from './claude.js';
import { checkToolCall, type HookInput } from './commands/guard.js';
import { claudeCodeAdapter } from './runners.js';
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
const readJson = (file: string) => JSON.parse(read(file));
const api = () =>
  fakeApi()
    .on('GET /v2/user', { user: { id: 777, username: 'dara' } })
    .on('GET /v2/list/L1', LIST);
const frontmatter = (md: string) => parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(md)![1]!) as Record<string, string>;

function rnProject() {
  const p = tempProject({ config: null, env: `CLICKUP_API_TOKEN=${TOKEN}\n` });
  p.write('package.json', {
    name: 'app',
    dependencies: { 'react-native': '0.86.0' },
    scripts: { lint: 'eslint .', test: 'jest' },
  });
  p.write('pnpm-lock.yaml', '');
  return p;
}
const init = (...args: string[]) =>
  cli(['init', '--yes', '--list', 'L1', '--no-doctor', ...args], { cwd: project.dir, api: api() });

describe('Claude Code files', () => {
  it('init --tools claude-code writes one agent per role, the run settings, the guard hook and CLAUDE.md', async () => {
    project = rnProject();
    const r = await init('--tools', 'claude-code', '--figma');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    for (const name of ['orchestrator', 'coder', 'reviewer', 'tester']) {
      expect(existsSync(join(project.dir, '.claude', 'agents', `${name}.md`))).toBe(true);
    }
    // Only Claude Code: no OpenCode or Antigravity agent files.
    expect(existsSync(join(project.dir, '.opencode'))).toBe(false);
    expect(existsSync(join(project.dir, '.agents', 'agents'))).toBe(false);

    const orchestrator = read('.claude/agents/orchestrator.md');
    expect(frontmatter(orchestrator)).toMatchObject({
      name: 'orchestrator',
      tools: 'Read, Grep, Glob, Write, Bash, Agent(coder, reviewer, tester)',
      model: 'inherit',
    });
    expect(orchestrator).toContain('You are the **orchestrator**');
    expect(frontmatter(read('.claude/agents/reviewer.md')).tools).toBe(
      'Read, Grep, Glob, Write, Bash, mcp__figma__get_design_context, mcp__figma__get_metadata, mcp__figma__get_variable_defs, mcp__figma__get_screenshot, mcp__figma__whoami',
    );
    expect(frontmatter(read('.claude/agents/tester.md')).tools).toBe('Read, Grep, Glob, Edit, Write, Bash');

    const run = readJson(CLAUDE_RUN_SETTINGS);
    expect(run.permissions.allow).toEqual(expect.arrayContaining(['Edit', 'Bash(pnpm lint)', 'Bash(pnpm lint *)']));
    expect(run.permissions.deny).toEqual(expect.arrayContaining(['Bash(git push *)', 'Read(./.env)']));
    expect(readJson('.claude/settings.json')).toEqual({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'npx tossana-agents guard' }] }] },
    });
    expect(read('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(readJson('.mcp.json').mcpServers.figma).toEqual({ type: 'http', url: 'http://127.0.0.1:3845/mcp' });
  });

  it("merges into the user's .claude/settings.json and CLAUDE.md, and removes only its own hook later", () => {
    project = tempProject();
    project.write('.claude/settings.json', {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check' }] }] },
    });
    project.write('CLAUDE.md', '# Our notes\r\nUse tabs.\r\n');
    const withClaude = parseConfig({ ...CONFIG, tools: ['opencode', 'claude-code'] });
    expect(applyClaudeSettings(project.dir, withClaude, 'tossana-agents').map((r) => r.action)).toEqual([
      'added',
      'updated',
    ]);
    expect(readJson('.claude/settings.json')).toEqual({
      model: 'opus',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'tossana-agents guard' }] },
        ],
      },
    });
    expect(read('CLAUDE.md')).toBe('# Our notes\r\nUse tabs.\r\n\r\n@AGENTS.md\r\n');
    expect(applyClaudeSettings(project.dir, withClaude, 'tossana-agents').map((r) => r.action)).toEqual([
      'unchanged',
      'unchanged',
    ]);

    applyClaudeSettings(project.dir, parseConfig(CONFIG), 'tossana-agents');
    expect(readJson('.claude/settings.json')).toEqual({
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-check' }] }] },
    });
  });

  it('runs claude headless with the orchestrator, dontAsk and the run settings', () => {
    const adapter = claudeCodeAdapter(fakeExec(), '.');
    expect(adapter.buildCommand({ agent: 'orchestrator', prompt: 'Work on T1', cwd: '.' })).toEqual({
      cmd: 'claude',
      args: [
        '-p',
        'Work on T1',
        '--agent',
        'orchestrator',
        '--permission-mode',
        'dontAsk',
        '--settings',
        CLAUDE_RUN_SETTINGS,
      ],
    });
  });
});

describe('doctor with Claude Code', () => {
  it('fails when the guard hook is missing or the kit is not installed (hooks fail open)', async () => {
    project = tempProject({ config: { ...CONFIG, tools: ['claude-code'] } });
    project.write('package.json', { name: 'app' });
    const doctorApi = api();
    let r = await cli(['doctor'], { cwd: project.dir, api: doctorApi });
    expect(r.out).toMatch(/❌ Claude Code guard hook in \.claude\/settings\.json/);
    expect(r.out).toMatch(/❌ Guard command can run \(tossana-agents installed\)/);
    applyClaudeSettings(project.dir, parseConfig({ ...CONFIG, tools: ['claude-code'] }), 'npx tossana-agents');
    project.write('node_modules/@tossana/agents/package.json', { name: '@tossana/agents' });
    r = await cli(['doctor'], { cwd: project.dir, api: api() });
    expect(r.out).toMatch(/✅ Claude Code guard hook/);
    expect(r.out).toMatch(/✅ Guard command can run/);
  });
});

describe('tossana-agents guard (Claude Code PreToolUse hook)', () => {
  const call = (agent: string | undefined, tool: string, input: Record<string, unknown>) =>
    checkToolCall(
      { cwd: project.dir, agent_type: agent, tool_name: tool, tool_input: input } as HookInput,
      project.dir,
    );

  it('limits each role to its preset and keeps the locked rules for every agent', () => {
    project = tempProject({
      config: {
        ...CONFIG,
        project: { ...CONFIG.project, type: 'react-native' },
        commands: { lint: 'pnpm lint', test: 'pnpm test' },
      },
    });
    // A developer's own session: the kit does not interfere.
    expect(call(undefined, 'Bash', { command: 'git push' })).toBeNull();

    // Locked for every agent.
    expect(call('coder', 'Bash', { command: 'git push origin task/T1' })).toBe('agents never push');
    expect(call('coder', 'Bash', { command: 'pnpm lint && git push' })).toBe('agents never push');
    expect(call('orchestrator', 'Bash', { command: 'npx tossana-agents clickup status T1 done' })).toBe(
      'only a human sets Done/Complete/Closed',
    );
    expect(call('reviewer', 'Read', { file_path: `${project.dir}/.env` })).toBe(
      'agents never read or change .env files',
    );
    expect(call('reviewer', 'Bash', { command: 'curl https://api.clickup.com/api/v2/task/T1' })).toMatch(
      /through the kit/,
    );

    // Coder: edits code, runs the gate, commits; no history rewrite, no status change.
    expect(call('coder', 'Edit', { file_path: join(project.dir, 'src', 'App.tsx') })).toBeNull();
    expect(call('coder', 'Bash', { command: 'pnpm lint' })).toBeNull();
    expect(call('coder', 'Bash', { command: 'git add -A && git commit -m "T1: x"' })).toBeNull();
    expect(call('coder', 'Bash', { command: 'git reset --hard' })).toMatch(/may never run "git reset"/);
    expect(call('coder', 'Bash', { command: 'npx tossana-agents clickup status T1 review' })).toMatch(/may never run/);
    expect(call('coder', 'Edit', { file_path: join(project.dir, '.claude', 'settings.json') })).toMatch(/protected/);
    expect(call('coder', 'Edit', { file_path: join(project.dir, '..', 'other', 'x.ts') })).toMatch(
      /inside the project/,
    );

    // Reviewer: read-only, except its comment draft; no commits.
    expect(call('reviewer', 'Edit', { file_path: join(project.dir, 'src', 'App.tsx') })).toMatch(/read-only/);
    expect(call('reviewer', 'Write', { file_path: join(project.dir, '.tossana', 'tmp', 'T1-reviewer.md') })).toBeNull();
    expect(call('reviewer', 'Bash', { command: 'git commit -m x' })).toMatch(/may not run "git commit -m x"/);
    expect(call('reviewer', 'Bash', { command: 'npx tossana-agents clickup comment T1 --file x.md' })).toBeNull();

    // Tester: test files only, stages by name.
    expect(call('tester', 'Write', { file_path: join(project.dir, 'src', 'App.test.tsx') })).toBeNull();
    expect(call('tester', 'Edit', { file_path: join(project.dir, 'src', 'App.tsx') })).toMatch(/test files only/);
    expect(call('tester', 'Bash', { command: 'git add .' })).toMatch(/may never run "git add ."/);

    // Default deny for other tools; only the orchestrator starts agents, and only pipeline roles.
    expect(call('coder', 'WebFetch', { url: 'https://example.com' })).toMatch(/default deny/);
    expect(call('orchestrator', 'Agent', { subagent_type: 'coder' })).toBeNull();
    expect(call('orchestrator', 'Agent', { subagent_type: 'general-purpose' })).toMatch(/may not start/);
    expect(call('coder', 'Agent', { subagent_type: 'reviewer' })).toMatch(/may not start/);
    expect(call('coder', 'mcp__figma__get_design_context', {})).toMatch(/may not use/);

    // Agents the kit does not manage (Claude's own helpers) are left alone, except for the locked rules.
    expect(call('Explore', 'Bash', { command: 'ls' })).toBeNull();
  });

  it('blocks with exit code 2 and a reason; fails closed when the input is broken', async () => {
    project = tempProject();
    const run = (stdin: string) => cli(['guard'], { cwd: project.dir, stdin });
    let r = await run(JSON.stringify({ agent_type: 'coder', tool_name: 'Bash', tool_input: { command: 'git push' } }));
    expect(r.code).toBe(2);
    expect(r.err).toContain('BLOCKED by the Tossana agent kit: agents never push');
    r = await run(JSON.stringify({ agent_type: 'coder', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }));
    expect(r.code).toBe(0);
    project.write('agent.config.json', '{ not json');
    r = await run(JSON.stringify({ agent_type: 'coder', tool_name: 'Bash', tool_input: { command: 'pnpm lint' } }));
    expect(r.code).toBe(2);
    expect(r.err).toContain('could not check this call');
  });
});
