import { describe, expect, it } from 'vitest';
import { buildPlan, rootPrefix, titleFromFile } from './local-docs-plan.js';

const ROOT = 'prd-app';
const f = (name: string, content = `# ${name}`) => ({ name, content });

describe('local docs plan', () => {
  it('makes titles from file names', () => {
    expect(titleFromFile('prd-app__implementation__01-architecture.md', ROOT)).toBe('implementation – 01 architecture');
    expect(titleFromFile('prd-app__overview.md', ROOT)).toBe('overview');
    expect(titleFromFile('meeting-notes.md', ROOT)).toBe('meeting notes');
    expect(titleFromFile('prd-app.md', ROOT)).toBe('prd app');
  });

  it('finds the shared root prefix', () => {
    expect(rootPrefix(['prd-app__a.md', 'prd-app__b__c.md', 'notes.md'])).toBe('prd-app');
    expect(rootPrefix(['a.md'])).toBeNull();
  });

  it('groups files under parent pages, keeps numeric order and ignores INDEX.md', () => {
    const plan = buildPlan(
      [
        f('INDEX.md'),
        f('prd-app__implementation__10-release.md'),
        f('prd-app__implementation__02-design.md'),
        f('prd-app__implementation__01-architecture.md'),
        f('prd-app__implementation.md', 'impl intro'),
        f('prd-app__onboarding__glossary.md'),
        f('prd-app__overview.md'),
        f('meeting-notes.md'),
        f('prd-app.md'),
        f('notes.txt'),
      ],
      ['implementation', 'onboarding'],
    );
    expect(plan.map((p) => p.title)).toEqual(['meeting notes', 'prd app', 'Implementation', 'Onboarding', 'overview']);
    const impl = plan.find((p) => p.title === 'Implementation')!;
    expect(impl).toMatchObject({ file: 'prd-app__implementation.md', content: 'impl intro' });
    expect(impl.children.map((c) => c.title)).toEqual([
      'implementation – 01 architecture',
      'implementation – 02 design',
      'implementation – 10 release',
    ]);
    const onboarding = plan.find((p) => p.title === 'Onboarding')!;
    expect(onboarding).toMatchObject({ file: null, content: '' });
    expect(onboarding.children.map((c) => c.title)).toEqual(['onboarding – glossary']);
  });

  it('keeps the content exactly', () => {
    const content = '# Title\r\n\r\n| a | b |\n|---|---|\n`code` "quotes" ខ្មែរ\n';
    expect(buildPlan([f('x.md', content)], [])[0]!.content).toBe(content);
  });
});
