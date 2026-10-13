import { describe, expect, it } from 'vitest';
import { parseProfile, profileInitials, profileLabel, profileSlug, ProfileError } from './profiles.js';

const valid = { name: 'Rei – Mobile', tool: 'codex', skills: ['mobile-master'], mcp: ['figma'] };

describe('profile schema', () => {
  it('accepts a profile and fills defaults', () => {
    expect(parseProfile({ name: 'Joe – Backend', tool: 'claude-code' })).toEqual({
      version: 1,
      name: 'Joe – Backend',
      tool: 'claude-code',
      skills: [],
      mcp: [],
    });
    expect(parseProfile({ ...valid, initials: 'RM', color: 'blue' })).toMatchObject({ initials: 'RM', color: 'blue' });
  });

  it('refuses unknown keys, so a token can never be stored in a profile', () => {
    expect(() => parseProfile({ ...valid, token: 'abc' })).toThrow(/Unrecognized key/);
    expect(() => parseProfile({ ...valid, env: { CLICKUP_API_TOKEN: 'x' } })).toThrow(ProfileError);
  });

  it.each([
    ['a ClickUp token', 'pk_12345678_ABCDEFGHIJKLMNOP'],
    ['an API key', 'sk-abcdefghijklmnop'],
    ['a GitHub token', 'ghp_abcdefghijklmnop'],
    ['a long random string', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7'],
  ])('refuses a name that looks like %s', (_what, name) => {
    expect(() => parseProfile({ ...valid, name })).toThrow(/looks like a secret/);
  });

  it('refuses bad tools, skills, MCP servers, colors and multi-line names', () => {
    expect(() => parseProfile({ ...valid, tool: 'cursor' })).toThrow(/tool/);
    expect(() => parseProfile({ ...valid, skills: ['../etc'] })).toThrow(/skills/);
    expect(() => parseProfile({ ...valid, skills: ['a', 'a'] })).toThrow(/twice/);
    expect(() => parseProfile({ ...valid, mcp: ['github'] })).toThrow(/mcp/);
    expect(() => parseProfile({ ...valid, color: '#ff0000' })).toThrow(/color/);
    expect(() => parseProfile({ ...valid, name: 'Rei\nMobile' })).toThrow(/one line/);
    expect(() => parseProfile({ ...valid, initials: 'ABCD' })).toThrow(/initials/);
    expect(() => parseProfile({ ...valid, name: 'Rei "Mobile"' })).toThrow(/quotes/);
    expect(() => parseProfile({ ...valid, name: 'Rei [x]' })).toThrow(/brackets/);
    expect(() => parseProfile({ ...valid, name: ' ' })).toThrow(/name/);
  });
});

describe('profile helpers', () => {
  it('makes slugs from names', () => {
    expect(profileSlug('Rei – Mobile')).toBe('rei-mobile');
    expect(profileSlug('  Joe — Backend (API) ')).toBe('joe-backend-api');
    expect(profileSlug('Đặng Café')).toBe('ang-cafe');
    expect(profileSlug('សារ៉ាត់')).toBe(''); // no Latin letters: the user picks an id
  });

  it('makes initials', () => {
    expect(profileInitials({ name: 'Rei – Mobile' })).toBe('RM');
    expect(profileInitials({ name: 'joe' })).toBe('J');
    expect(profileInitials({ name: 'Rei – Mobile', initials: 'R' })).toBe('R');
    expect(profileInitials({ name: 'សារ៉ាត់ ណារ៉ាក់' })).toHaveLength(2);
  });

  it('labels who ran a task', () => {
    expect(profileLabel('Rei – Mobile', 'codex')).toBe('Rei – Mobile · Codex');
    expect(profileLabel(null, 'claude-code')).toBe('Claude Code');
    expect(profileLabel(undefined, 'custom')).toBe('Custom command');
  });
});
