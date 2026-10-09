import { describe, expect, it } from 'vitest';
import { KIT_VERSION } from './version.js';

describe('version', () => {
  it('reads the version from package.json', () => {
    expect(KIT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
