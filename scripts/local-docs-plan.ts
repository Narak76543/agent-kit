/**
 * Plans a ClickUp doc from a folder of synced Markdown files (the output of `clickup sync-docs`):
 * file names like `<root>__<group>__<NN>-<name>.md` become nested pages.
 *
 * - `<root>__<group>.md` becomes the group's parent page (title = group name, capitalized);
 *   its children are the `<root>__<group>__*.md` files.
 * - Every other file is a top-level page.
 * - Titles come from the file name: the `<root>__` prefix is dropped, `__` becomes " – ", `-` becomes a
 *   space ("implementation – 01 architecture").
 * - Order: numeric-aware by file name, so 01, 02, … 16 stay in order.
 * - INDEX.md is ignored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LocalPage {
  title: string;
  /** Source file, for display; null for a group page without its own file. */
  file: string | null;
  content: string;
  children: LocalPage[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Longest common `xxx__` prefix shared by the grouped files (e.g. "prd-ekmong-mobile"). */
export function rootPrefix(names: string[]): string | null {
  const roots = names.filter((n) => n.includes('__')).map((n) => n.split('__')[0]!);
  if (!roots.length) return null;
  const counts = new Map<string, number>();
  for (const r of roots) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

export function titleFromFile(base: string, root: string | null): string {
  let name = base.replace(/\.md$/i, '');
  if (root && name.startsWith(`${root}__`)) name = name.slice(root.length + 2);
  return name
    .split('__')
    .map((part) => part.replace(/-/g, ' ').trim())
    .join(' – ');
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Builds the page tree from file names and contents (pure; used by planLocalDocs and tests). */
export function buildPlan(files: { name: string; content: string }[], groups: string[]): LocalPage[] {
  const md = files.filter((f) => /\.md$/i.test(f.name) && f.name.toLowerCase() !== 'index.md');
  // Compare without ".md" so a file comes before files that extend its name (prd-app before prd-app__x).
  const key = (name: string) => name.replace(/\.md$/i, '');
  md.sort((a, b) => collator.compare(key(a.name), key(b.name)));
  const root = rootPrefix(md.map((f) => f.name));
  const pages: LocalPage[] = [];
  const groupPages = new Map<string, LocalPage>();

  const groupOf = (name: string): { group: string; isParent: boolean } | null => {
    if (!root) return null;
    for (const g of groups) {
      if (name.toLowerCase() === `${root}__${g}.md`.toLowerCase()) return { group: g, isParent: true };
      if (name.toLowerCase().startsWith(`${root}__${g}__`.toLowerCase())) return { group: g, isParent: false };
    }
    return null;
  };

  const ensureGroup = (g: string): LocalPage => {
    let page = groupPages.get(g);
    if (!page) {
      page = { title: capitalize(g), file: null, content: '', children: [] };
      groupPages.set(g, page);
      pages.push(page);
    }
    return page;
  };

  for (const f of md) {
    const g = groupOf(f.name);
    if (!g) {
      pages.push({ title: titleFromFile(f.name, root), file: f.name, content: f.content, children: [] });
    } else if (g.isParent) {
      const page = ensureGroup(g.group);
      page.file = f.name;
      page.content = f.content;
    } else {
      ensureGroup(g.group).children.push({
        title: titleFromFile(f.name, root),
        file: f.name,
        content: f.content,
        children: [],
      });
    }
  }
  return pages;
}

export function planLocalDocs(dir: string, groups: string[]): LocalPage[] {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({ name: d.name, content: readFileSync(join(dir, d.name), 'utf8') }));
  return buildPlan(files, groups);
}
