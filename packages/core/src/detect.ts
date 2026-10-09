/**
 * Detects the project type, the skill the coder should use, the package manager and the
 * install/lint/typecheck/test commands. `init` shows the result and lets the user change it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectType } from './config.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export const SKILL_FOR_TYPE: Record<ProjectType, string> = {
  'react-native': 'mobile-master',
  flutter: 'flutter-master',
  nextjs: 'frontend-master',
  react: 'frontend-master',
  'node-backend': 'backend-master',
  other: 'backend-master',
};

export interface ProjectCommands {
  install?: string;
  lint?: string;
  typecheck?: string;
  test?: string;
}

export interface DetectedProject {
  type: ProjectType;
  skill: string;
  packageManager: PackageManager | null;
  commands: ProjectCommands;
  /** Why this type was chosen, for display. */
  reason: string;
}

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const BACKEND_DEPS = ['express', 'fastify', '@nestjs/core', 'koa', 'hono', '@hapi/hapi'];
const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'tsc', 'types'];
// The script `npm init` writes; it always fails, so it is not a real test command.
const NPM_PLACEHOLDER_TEST = /no test specified/;

export function detectProject(cwd: string): DetectedProject {
  const has = (file: string) => existsSync(join(cwd, file));
  const pkg = readPackageJson(cwd);

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = detectPackageManager(cwd, pkg);
    const result = (type: ProjectType, reason: string): DetectedProject => ({
      type,
      skill: SKILL_FOR_TYPE[type],
      packageManager: pm,
      commands: nodeCommands(pm, pkg, has('tsconfig.json')),
      reason,
    });
    if ('react-native' in deps || 'expo' in deps) return result('react-native', 'package.json uses react-native/expo');
    if (has('pubspec.yaml')) return flutter();
    if ('next' in deps) return result('nextjs', 'package.json uses next');
    if ('react' in deps) return result('react', 'package.json uses react');
    const backend = BACKEND_DEPS.find((d) => d in deps);
    if (backend) return result('node-backend', `package.json uses ${backend}`);
    return result('other', 'package.json found, no known framework');
  }

  if (has('pubspec.yaml')) return flutter();

  if (has('go.mod')) {
    return {
      type: 'other',
      skill: SKILL_FOR_TYPE.other,
      packageManager: null,
      commands: { install: 'go mod download', lint: 'go vet ./...', test: 'go test ./...' },
      reason: 'go.mod found (Go backend)',
    };
  }

  if (has('pyproject.toml') || has('requirements.txt')) {
    const pyproject = has('pyproject.toml') ? readFileSync(join(cwd, 'pyproject.toml'), 'utf8') : '';
    return {
      type: 'other',
      skill: SKILL_FOR_TYPE.other,
      packageManager: null,
      commands: {
        install: has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .',
        lint: /\bruff\b/.test(pyproject) ? 'ruff check .' : undefined,
        typecheck: /\bmypy\b/.test(pyproject) ? 'mypy .' : undefined,
        test: 'pytest',
      },
      reason: 'Python project found (backend)',
    };
  }

  return { type: 'other', skill: SKILL_FOR_TYPE.other, packageManager: null, commands: {}, reason: 'no known markers' };
}

function flutter(): DetectedProject {
  return {
    type: 'flutter',
    skill: SKILL_FOR_TYPE.flutter,
    packageManager: null,
    commands: { install: 'flutter pub get', lint: 'flutter analyze', test: 'flutter test' },
    reason: 'pubspec.yaml found',
  };
}

export function detectPackageManager(
  cwd: string,
  pkg: PackageJson | null = readPackageJson(cwd),
): PackageManager | null {
  const declared = /^(pnpm|npm|yarn|bun)@/.exec(pkg?.packageManager ?? '');
  if (declared) return declared[1] as PackageManager;
  const has = (file: string) => existsSync(join(cwd, file));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('package-lock.json') || pkg) return 'npm';
  return null;
}

function nodeCommands(pm: PackageManager | null, pkg: PackageJson, hasTsconfig: boolean): ProjectCommands {
  const p = pm ?? 'npm';
  const scripts = pkg.scripts ?? {};
  const run = (script: string) =>
    p === 'npm' ? (script === 'test' ? 'npm test' : `npm run ${script}`) : `${p} ${script}`;
  const exec = { pnpm: 'pnpm exec', npm: 'npx', yarn: 'yarn', bun: 'bunx' }[p];

  const typecheckScript = TYPECHECK_SCRIPTS.find((s) => scripts[s]);
  const testScript = scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test) ? 'test' : undefined;
  return {
    install: `${p} install`,
    lint: scripts.lint ? run('lint') : undefined,
    typecheck: typecheckScript ? run(typecheckScript) : hasTsconfig ? `${exec} tsc --noEmit` : undefined,
    test: testScript ? run(testScript) : undefined,
  };
}

function readPackageJson(cwd: string): PackageJson | null {
  const file = join(cwd, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as PackageJson;
  } catch {
    return {};
  }
}
