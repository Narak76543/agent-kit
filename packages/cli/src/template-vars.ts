/**
 * Values for the template placeholders, computed from agent.config.json. Permission blocks are
 * YAML lines for OpenCode agent frontmatter (4-space indent, inside a tool's rule map).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, type AgentConfig } from '@tossana/agents-core';
import { FIGMA_READ_TOOLS, FIGMA_SERVER_NAME } from './figma.js';
import { readTemplate } from './templates.js';
import { KIT_VERSION } from './version.js';

const KIT_PREFIXES = ['tossana-agents', 'npx tossana-agents'];
const INDENT = '    ';

/** A YAML key; double-quoted JSON strings are valid YAML. Backslash paths use single quotes. */
const rule = (pattern: string, action: 'allow' | 'deny') =>
  `${INDENT}${pattern.includes('\\') ? `'${pattern}'` : JSON.stringify(pattern)}: ${action}`;

/** Path rules in both separators: OpenCode on Windows may match paths with backslashes. */
const pathRules = (patterns: string[], action: 'allow' | 'deny') =>
  patterns.flatMap((p) =>
    p.includes('/') ? [rule(p, action), rule(p.replace(/\//g, '\\'), action)] : [rule(p, action)],
  );

const lines = (rules: string[]) => rules.join('\n');

export const TMP_EDIT = ['.tossana/tmp/*', '*/.tossana/tmp/*'];

export const TEST_GLOBS: Record<string, string[]> = {
  js: [
    '*.test.*',
    '*.spec.*',
    '__tests__/*',
    '*/__tests__/*',
    '__mocks__/*',
    '*/__mocks__/*',
    'tests/*',
    '*/tests/*',
    'test/*',
    '*/test/*',
    'e2e/*',
    '*/e2e/*',
  ],
  flutter: ['*_test.dart', 'test/*', '*/test/*', 'integration_test/*', '*/integration_test/*'],
  other: ['*_test.go', 'test_*.py', '*_test.py', '*.test.*', '*.spec.*', 'tests/*', '*/tests/*', 'test/*', '*/test/*'],
};

const TEST_DESCRIPTION: Record<string, string> = {
  js: '`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `tests/`, `test/`, `e2e/`',
  flutter: '`*_test.dart`, `test/`, `integration_test/`',
  other: '`*_test.go`, `test_*.py`, `*_test.py`, `*.test.*`, `*.spec.*`, `tests/`, `test/`',
};

export const testKind = (type: AgentConfig['project']['type']) =>
  type === 'flutter' ? 'flutter' : ['react-native', 'nextjs', 'react', 'node-backend'].includes(type) ? 'js' : 'other';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.expo',
  '.next',
  '.turbo',
  '.dart_tool',
  '.idea',
  '.vscode',
  '.gradle',
  'Pods',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.agents',
  '.opencode',
  '.agent',
]);

/** Top-level folders (with their first level) for the project section of AGENTS.md. */
export function projectTree(cwd: string, maxEntries = 40): string {
  const out: string[] = [];
  const dirs = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !IGNORED_DIRS.has(d.name) && !d.name.startsWith('.'))
          .map((d) => d.name)
          .sort()
      : [];
  for (const top of dirs(cwd)) {
    out.push(`${top}/`);
    for (const sub of dirs(join(cwd, top)).slice(0, 12)) out.push(`  ${sub}/`);
  }
  if (out.length > maxEntries) return [...out.slice(0, maxEntries), '…'].join('\n');
  return out.length ? out.join('\n') : '(empty)';
}

export function templateVars(
  config: AgentConfig,
  options: { kitCmd: string; cwd?: string; packageManager?: string | null; docsOutDir?: string },
): Record<string, string> {
  const { project, clickup, commands, pipeline } = config;
  const cmds = (['install', 'lint', 'typecheck', 'test'] as const).filter((k) => commands[k]);
  const gate = (['lint', 'typecheck', 'test'] as const).flatMap((k) => (commands[k] ? [`\`${commands[k]}\``] : []));
  const kind = testKind(project.type);
  const figmaText = (name: string) => (config.figma.enabled ? readTemplate(`figma/${name}.md`) : '');

  const kitRules = (subcommands: string[]) =>
    lines(KIT_PREFIXES.flatMap((p) => subcommands.map((s) => rule(`${p} clickup ${s}`, 'allow'))));

  const statusDoneDeny = ['done', 'Done', 'DONE', 'complete', 'Complete', 'COMPLETE', 'closed', 'Closed', 'CLOSED'].map(
    (w) => rule(`*tossana-agents clickup status *${w}*`, 'deny'),
  );

  return {
    'project.name': project.name,
    'project.type': project.type,
    'project.skill': project.skill,
    'project.stackLine': options.packageManager ? ` · **Package manager:** ${options.packageManager}` : '',
    'project.tree': options.cwd ? projectTree(options.cwd) : '',
    'kit.cmd': options.kitCmd,
    'kit.version': KIT_VERSION,
    ...Object.fromEntries(ROLES.map((r) => [`statuses.${r}`, clickup.statuses[r]])),
    'pipeline.maxRounds': String(pipeline.maxRounds),
    'pipeline.branchPrefix': pipeline.branchPrefix,
    'pipeline.baseBranch': pipeline.baseBranch,
    'docs.outDir': options.docsOutDir ?? clickup.docs.outDir,
    'commands.gate': gate.length ? gate.join(' · ') : '(no commands configured: set "commands" in agent.config.json)',
    'commands.table': cmds.length
      ? cmds.map((k) => `| ${k[0]!.toUpperCase()}${k.slice(1)} | \`${commands[k]}\` |`).join('\n')
      : '| (none yet) | set "commands" in agent.config.json |',
    'tests.description': TEST_DESCRIPTION[kind]!,
    'perm.readDeny': lines([rule('*.env', 'deny'), rule('*.env.*', 'deny'), rule('*.env.example', 'allow')]),
    // Optional Figma support: empty (line removed) unless figma.enabled.
    'perm.figma': config.figma.enabled ? lines(FIGMA_READ_TOOLS.map((t) => `  ${FIGMA_SERVER_NAME}_${t}: allow`)) : '',
    'figma.orchestrator': figmaText('orchestrator'),
    'figma.coder': figmaText('coder'),
    'figma.reviewer': figmaText('reviewer'),
    'figma.startTask': figmaText('start-task'),
    'perm.tmpEdit': lines(pathRules(TMP_EDIT, 'allow')),
    'perm.testEdit': lines(pathRules(TEST_GLOBS[kind]!, 'allow')),
    'perm.editDeny': lines([
      ...pathRules(
        ['*.env', '*.env.*', '.opencode/*', '*/.opencode/*', '.agents/*', '*/.agents/*', '.git/*', '*/.git/*'],
        'deny',
      ),
      rule('agent.config.json', 'deny'),
      rule('*agent.config.json', 'deny'),
      ...pathRules(TMP_EDIT, 'allow'),
    ]),
    'perm.kitAll': kitRules(['*']),
    'perm.kitTaskRead': kitRules(['get *', 'comments *', 'comment *', 'handoff *']),
    'perm.kitSubtask': kitRules(['subtask *']),
    'perm.statusDoneDeny': lines(statusDoneDeny),
    'perm.commonDeny': lines([
      rule('*api.clickup.com*', 'deny'),
      rule('*CLICKUP_API_TOKEN*', 'deny'),
      rule('*.env', 'deny'),
      rule('*.env *', 'deny'),
      rule('git push*', 'deny'),
      rule('*git push*', 'deny'),
    ]),
    'perm.commands.install': commands.install ? lines([rule(`${commands.install}*`, 'allow')]) : '',
    'perm.commands.quality': lines(
      (['lint', 'typecheck', 'test'] as const).flatMap((k) => (commands[k] ? [rule(`${commands[k]}*`, 'allow')] : [])),
    ),
  };
}
