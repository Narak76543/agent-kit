import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from './index.js';

describe('core', () => {
  it('exports its package name', () => {
    expect(CORE_PACKAGE).toBe('@tossana/agents-core');
  });
});
