import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KitError } from './errors.js';
import { appendHandoff, handoffPath, isValidTaskId, readHandoff } from './handoff.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tak-handoff-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isValidTaskId', () => {
  it.each(['86abc123', 'EKM-12', 'task_1'])('accepts %s', (id) => expect(isValidTaskId(id)).toBe(true));
  it.each(['', '../x', 'a/b', 'a\\b', 'a b', 'C:'])('rejects "%s"', (id) => expect(isValidTaskId(id)).toBe(false));
});

describe('handoff files', () => {
  it('builds the path with the platform separator', () => {
    expect(handoffPath(dir, 'T1')).toBe(join(dir, '.agents', 'handoff', 'T1.md'));
  });

  it('refuses task IDs that could escape the folder', () => {
    expect(() => handoffPath(dir, '../../etc')).toThrow(KitError);
    expect(() => appendHandoff(dir, '..\\x', 'h', 't')).toThrow(/invalid task id/);
  });

  it('creates the file with a header, then appends timestamped sections', () => {
    const file = appendHandoff(dir, 'T1', 'ClickUp comment', 'first', new Date('2026-10-09T10:00:00Z'));
    appendHandoff(dir, 'T1', 'Notes', 'second\r\nline two\r\n', new Date('2026-10-09T11:00:00Z'));
    expect(readFileSync(file, 'utf8')).toBe(
      '# Handoff log for task T1\n' +
        '\n## 2026-10-09T10:00:00.000Z — ClickUp comment\n\nfirst\n' +
        '\n## 2026-10-09T11:00:00.000Z — Notes\n\nsecond\nline two\n',
    );
  });

  it('readHandoff returns null before anything is written', () => {
    expect(readHandoff(dir, 'T2')).toBeNull();
    expect(existsSync(join(dir, '.agents'))).toBe(false);
    appendHandoff(dir, 'T2', 'h', 'x');
    expect(readHandoff(dir, 'T2')).toContain('# Handoff log for task T2');
  });
});
