import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPackageManager, detectProject } from './detect.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tak-detect-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, content: string | object = '') =>
  writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));

const pkg = (deps: Record<string, string>, scripts: Record<string, string> = {}, extra: object = {}) =>
  write('package.json', { dependencies: deps, scripts, ...extra });

describe('detectProject: types and skills', () => {
  it('detects React Native like EKMONG_MOBILE', () => {
    pkg(
      { 'react-native': '0.76.0', react: '18', expo: '52' },
      { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'jest' },
    );
    write('pnpm-lock.yaml');
    write('tsconfig.json', '{}');
    expect(detectProject(dir)).toEqual({
      type: 'react-native',
      skill: 'mobile-master',
      packageManager: 'pnpm',
      commands: { install: 'pnpm install', lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test' },
      reason: 'package.json uses react-native/expo',
    });
  });

  it('treats an Expo-only package.json as React Native', () => {
    pkg({ expo: '52' });
    expect(detectProject(dir).type).toBe('react-native');
  });

  it('detects Flutter', () => {
    write('pubspec.yaml', 'name: app\nflutter:\n');
    expect(detectProject(dir)).toMatchObject({
      type: 'flutter',
      skill: 'flutter-master',
      commands: { install: 'flutter pub get', lint: 'flutter analyze', test: 'flutter test' },
    });
  });

  it('detects Flutter even with a helper package.json', () => {
    pkg({ prettier: '3' });
    write('pubspec.yaml', 'name: app');
    expect(detectProject(dir).type).toBe('flutter');
  });

  it('detects Next.js before React', () => {
    pkg({ next: '15', react: '19' });
    expect(detectProject(dir)).toMatchObject({ type: 'nextjs', skill: 'frontend-master' });
  });

  it('detects React (devDependencies count too)', () => {
    write('package.json', { devDependencies: { react: '19', vite: '6' } });
    expect(detectProject(dir)).toMatchObject({ type: 'react', skill: 'frontend-master' });
  });

  it.each(['express', 'fastify', '@nestjs/core'])('detects a Node backend using %s', (dep) => {
    pkg({ [dep]: '1' });
    expect(detectProject(dir)).toMatchObject({ type: 'node-backend', skill: 'backend-master' });
  });

  it('falls back to "other" for a plain Node package', () => {
    pkg({ lodash: '4' });
    expect(detectProject(dir)).toMatchObject({ type: 'other', skill: 'backend-master' });
  });

  it('detects a Go backend', () => {
    write('go.mod', 'module x');
    expect(detectProject(dir)).toMatchObject({
      type: 'other',
      skill: 'backend-master',
      commands: { install: 'go mod download', lint: 'go vet ./...', test: 'go test ./...' },
    });
  });

  it('detects a Python backend and its tools', () => {
    write('pyproject.toml', '[tool.ruff]\n[tool.mypy]\n');
    expect(detectProject(dir).commands).toEqual({
      install: 'pip install -e .',
      lint: 'ruff check .',
      typecheck: 'mypy .',
      test: 'pytest',
    });
    write('requirements.txt', 'fastapi');
    expect(detectProject(dir).commands.install).toBe('pip install -r requirements.txt');
  });

  it('handles an empty folder', () => {
    expect(detectProject(dir)).toEqual({
      type: 'other',
      skill: 'backend-master',
      packageManager: null,
      commands: {},
      reason: 'no known markers',
    });
  });

  it('does not crash on a broken package.json', () => {
    write('package.json', '{ not json');
    expect(detectProject(dir)).toMatchObject({ type: 'other', packageManager: 'npm' });
  });
});

describe('detectProject: commands', () => {
  it('uses npm run, and npm test', () => {
    pkg({ react: '19' }, { lint: 'eslint .', 'type-check': 'tsc', test: 'vitest' });
    write('package-lock.json', '{}');
    expect(detectProject(dir).commands).toEqual({
      install: 'npm install',
      lint: 'npm run lint',
      typecheck: 'npm run type-check',
      test: 'npm test',
    });
  });

  it('falls back to tsc when there is a tsconfig but no typecheck script', () => {
    pkg({ react: '19' });
    write('tsconfig.json', '{}');
    write('yarn.lock');
    expect(detectProject(dir).commands).toEqual({ install: 'yarn install', typecheck: 'yarn tsc --noEmit' });
  });

  it('ignores the placeholder test script from npm init', () => {
    pkg({}, { test: 'echo "Error: no test specified" && exit 1' });
    expect(detectProject(dir).commands.test).toBeUndefined();
  });
});

describe('detectPackageManager', () => {
  it('prefers the packageManager field', () => {
    pkg({}, {}, { packageManager: 'yarn@4.5.0' });
    write('pnpm-lock.yaml');
    expect(detectPackageManager(dir)).toBe('yarn');
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ])('reads %s as %s', (lockfile, pm) => {
    write(lockfile);
    expect(detectPackageManager(dir)).toBe(pm);
  });

  it('defaults to npm with a package.json, null without', () => {
    expect(detectPackageManager(dir)).toBeNull();
    pkg({});
    expect(detectPackageManager(dir)).toBe('npm');
  });

  it('uses bunx for bun projects without a typecheck script', () => {
    pkg({ react: '19' });
    write('bun.lock');
    write('tsconfig.json', '{}');
    expect(detectProject(dir).commands.typecheck).toBe('bunx tsc --noEmit');
  });
});
