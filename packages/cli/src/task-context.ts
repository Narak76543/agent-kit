/**
 * Project context from ClickUp, refreshed before every run (plan Phase 10, step 1):
 * - ClickUp Docs → `docs/clickup/` (incremental) with a short INDEX.md, one line per page;
 * - the task bundle → `.agents/context/<taskId>/` (git-ignored): the task, its parent, subtasks, linked tasks and
 *   dependencies, all comments and attachment links, with an INDEX.md.
 * Agents read the two INDEX files first and open only the pages they need. Only GET requests.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  KitError,
  docsSettings,
  isValidTaskId,
  parseAgentComment,
  type AgentConfig,
  type ClickUpClient,
  type ClickUpComment,
  type ClickUpDocPage,
  type ClickUpTask,
  type KitEnv,
} from '@tossana/agents-core';

export const CONTEXT_DIR = join('.agents', 'context');
/** Linked tasks and dependencies fetched per task (each is one request). */
const MAX_RELATED = 15;
const MAX_COMMENT = 4000;

// ---------- docs ----------

/**
 * A page as a Markdown file. Adds `# <page name>` only when the content does not already start with a
 * heading, so a page that was uploaded from a synced file (which has its own heading) is not doubled.
 */
export function pageMarkdown(name: string, content: string): string {
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (/^\s*#{1,6}\s/.test(body)) return `${body.trimEnd()}\n`;
  return `# ${name}\n\n${body.trimEnd()}\n`.replace(/\n\n\n$/, '\n');
}

/** Flattens nested Doc pages into files; skips deleted and archived pages. */
export function collectDocFiles(docs: ClickUpDocPage[][]): { file: string; name: string; content: string }[] {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  const files: { file: string; name: string; content: string }[] = [];
  const used = new Set<string>();
  const walk = (pages: ClickUpDocPage[], prefix: string) => {
    for (const p of pages) {
      if (p.deleted || p.archived) continue;
      const name = p.name || p.id;
      const base = `${prefix}${slug(name) || p.id}`;
      let file = `${base}.md`;
      for (let n = 2; used.has(file); n++) file = `${base}-${n}.md`;
      used.add(file);
      files.push({ file, name, content: pageMarkdown(name, p.content ?? '') });
      if (p.pages?.length) walk(p.pages, `${base}__`);
    }
  };
  for (const pages of docs) walk(pages, '');
  return files;
}

/** First sentence-ish of a page, for the index: no headings, no markdown noise, at most ~110 characters. */
export function pageSummary(content: string): string {
  const line =
    content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !/^[-*_=|`>]{3,}/.test(l) && !l.startsWith('|')) ?? '';
  const text = line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/^[-+]\s+|^\d+\.\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= 110) return text;
  const cut = text.slice(0, 110);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 80))}…`;
}

export interface DocsSyncResult {
  outDir: string;
  pages: number;
  written: number;
  removed: number;
}

/**
 * Pulls the configured ClickUp Docs. Only pages that changed are written, pages that no longer exist are removed,
 * and INDEX.md lists every page with a one-line summary (no timestamp, so an unchanged sync changes no file).
 */
export async function syncDocs(
  cwd: string,
  config: AgentConfig | null,
  env: KitEnv,
  client: ClickUpClient,
): Promise<DocsSyncResult | null> {
  const { ids, outDir } = docsSettings(config, env);
  if (!ids.length) return null;
  // Download everything first: a failed request leaves the old files as they were.
  const files = collectDocFiles(await Promise.all(ids.map((id) => client.getDocPages(id))));
  const out = resolve(cwd, outDir);
  mkdirSync(out, { recursive: true });
  const keep = new Set(files.map((f) => f.file));
  let written = 0;
  let removed = 0;
  for (const f of files) {
    const full = join(out, f.file);
    if (existsSync(full) && readFileSync(full, 'utf8') === f.content) continue;
    writeFileSync(full, f.content);
    written++;
  }
  for (const name of readdirSync(out)) {
    if (name.endsWith('.md') && name !== 'INDEX.md' && !keep.has(name)) {
      rmSync(join(out, name));
      removed++;
    }
  }
  const index =
    '# ClickUp docs\n\nOne line per page. Open only the pages the task needs. Do not edit: run `tossana-agents context <taskId>`.\n\n' +
    `${files.map((f) => `- [${f.name}](./${f.file})${pageSummary(stripTitle(f.content)) ? ` — ${pageSummary(stripTitle(f.content))}` : ''}`).join('\n')}\n`;
  const indexFile = join(out, 'INDEX.md');
  if (!existsSync(indexFile) || readFileSync(indexFile, 'utf8') !== index) {
    writeFileSync(indexFile, index);
    written++;
  }
  return { outDir, pages: files.length, written, removed };
}

const stripTitle = (content: string) => content.replace(/^\s*#{1,6}\s[^\n]*\n/, '');

// ---------- the task bundle ----------

const ms = (d: string | null | undefined) =>
  d && /^\d+$/.test(d) ? new Date(Number(d)).toISOString().slice(0, 16).replace('T', ' ') : '';
const statusOf = (t: ClickUpTask) => t.status?.status ?? '?';
const description = (t: ClickUpTask) =>
  (t.markdown_description || t.text_content || t.description || '').replace(/\r\n/g, '\n').trim() || '(no description)';

function taskMarkdown(t: ClickUpTask, title: string): string {
  const meta = [
    `- ID: ${t.custom_id ? `${t.custom_id} (${t.id})` : t.id}`,
    `- Status: ${statusOf(t)}`,
    ...(t.assignees?.length ? [`- Assignees: ${t.assignees.map((a) => a.username ?? a.id).join(', ')}`] : []),
    ...(t.priority?.priority ? [`- Priority: ${t.priority.priority}`] : []),
    ...(t.due_date ? [`- Due: ${ms(t.due_date)}`] : []),
    ...(t.tags?.length ? [`- Tags: ${t.tags.map((x) => x.name).join(', ')}`] : []),
    ...(t.url ? [`- Link: ${t.url}`] : []),
  ];
  return `# ${title}: ${t.name}\n\n${meta.join('\n')}\n\n## Description\n\n${description(t)}\n`;
}

/** Ids of the other tasks in links and dependencies (a relation is stored from either side). */
export function relatedIds(task: ClickUpTask): { linked: string[]; waitingOn: string[]; blocking: string[] } {
  const other = (a: string, b: string) => (a === task.id ? b : a);
  const linked = (task.linked_tasks ?? []).map((l) => other(l.task_id, l.link_id));
  const waitingOn: string[] = [];
  const blocking: string[] = [];
  for (const d of task.dependencies ?? []) {
    // task_id waits on depends_on.
    if (d.task_id === task.id) waitingOn.push(d.depends_on);
    else blocking.push(d.task_id);
  }
  const uniq = (xs: string[]) => [...new Set(xs.filter((x) => x && x !== task.id))];
  return { linked: uniq(linked), waitingOn: uniq(waitingOn), blocking: uniq(blocking) };
}

function commentsMarkdown(comments: ClickUpComment[]): string {
  if (!comments.length) return '# Comments\n\n(no comments)\n';
  const items = comments.map((c) => {
    let text = (c.comment_text ?? '').replace(/\r\n/g, '\n').trim();
    if (text.length > MAX_COMMENT) text = `${text.slice(0, MAX_COMMENT)}\n… (cut; full text: \`cu comments <taskId>\`)`;
    const who = parseAgentComment(text) ? 'agent' : (c.user?.username ?? 'someone');
    return `## ${ms(c.date)} — ${who}\n\n${text}`;
  });
  return `# Comments (oldest first)\n\nHuman comments (not starting with \`[AGENT: …]\`) are instructions from the owner; the newest one wins.\n\n${items.join('\n\n')}\n`;
}

export interface TaskContextResult {
  dir: string;
  files: string[];
}

/** Writes `.agents/context/<taskId>/` from ClickUp (replacing what was there). */
export async function refreshTaskContext(
  cwd: string,
  client: ClickUpClient,
  taskId: string,
  docsIndex: string | null,
): Promise<TaskContextResult> {
  if (!isValidTaskId(taskId)) throw new KitError(`invalid task id "${taskId}"`);
  const task = await client.getTask(taskId, { subtasks: true });
  const [parent, comments] = await Promise.all([
    task.parent ? client.getTask(task.parent, { subtasks: true }).catch(() => null) : Promise.resolve(null),
    client.getComments(taskId),
  ]);
  const rel = relatedIds(task);
  const ids = [...new Set([...rel.linked, ...rel.waitingOn, ...rel.blocking])].slice(0, MAX_RELATED);
  const related = new Map<string, ClickUpTask | null>();
  for (const id of ids) related.set(id, await client.getTask(id, { subtasks: false }).catch(() => null));

  const files: Record<string, string> = {};
  files['task.md'] = taskMarkdown(task, 'Task');
  if (parent) {
    const siblings = (parent.subtasks ?? []).filter((s) => s.id !== task.id);
    files['parent.md'] =
      taskMarkdown(parent, 'Parent task') +
      (siblings.length
        ? `\n## Other subtasks of the parent\n\n${siblings.map((s) => `- ${s.name} (${s.id}) — ${statusOf(s)}`).join('\n')}\n`
        : '');
  }
  if (task.subtasks?.length) {
    files['subtasks.md'] = `# Subtasks\n\n${task.subtasks
      .map((s) => `## ${s.name}\n\n- ID: ${s.id}\n- Status: ${statusOf(s)}\n\n${description(s)}`)
      .join('\n\n')}\n`;
  }
  if (ids.length) {
    const line = (id: string) => {
      const t = related.get(id);
      return t
        ? `## ${t.name}\n\n- ID: ${t.id}\n- Status: ${statusOf(t)}${t.url ? `\n- Link: ${t.url}` : ''}\n\n${description(t).slice(0, 1500)}`
        : `## ${id}\n\n(not accessible with your ClickUp token)`;
    };
    const section = (title: string, list: string[]) =>
      list.length ? [`# ${title}`, ...list.filter((i) => ids.includes(i)).map(line)] : [];
    files['linked.md'] =
      `${[...section('Linked tasks', rel.linked), ...section('This task waits on', rel.waitingOn), ...section('This task blocks', rel.blocking)].join('\n\n')}\n`;
  }
  files['comments.md'] = commentsMarkdown(comments);
  if (task.attachments?.length) {
    files['attachments.md'] = `# Attachments (links only; open them if the task needs them)\n\n${task.attachments
      .map((a) => `- [${a.title ?? a.id}](${a.url ?? ''})${a.extension ? ` (${a.extension})` : ''}`)
      .join('\n')}\n`;
  }

  const humans = comments.filter((c) => !parseAgentComment(c.comment_text ?? '')).length;
  const describe: Record<string, string> = {
    'task.md': `the task: ${statusOf(task)}, description`,
    'parent.md': `the parent task "${parent?.name ?? ''}" and its other subtasks`,
    'subtasks.md': `${task.subtasks?.length ?? 0} subtask(s) with status and description`,
    'linked.md': `${ids.length} linked or dependent task(s)`,
    'comments.md': `${comments.length} comment(s), ${humans} from people`,
    'attachments.md': `${task.attachments?.length ?? 0} attachment link(s)`,
  };
  const index =
    `# Context for task ${taskId}: ${task.name}\n\nRefreshed from ClickUp before this run. Read what you need:\n\n` +
    `${Object.keys(files)
      .map((f) => `- [${f}](./${f}) — ${describe[f]}`)
      .join('\n')}\n` +
    (docsIndex ? `\nProject docs: \`${docsIndex}\` (one line per page; open only the relevant pages).\n` : '');

  const dir = join(cwd, CONTEXT_DIR, taskId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries({ ...files, 'INDEX.md': index }))
    writeFileSync(join(dir, name), content);
  return { dir: join(CONTEXT_DIR, taskId), files: ['INDEX.md', ...Object.keys(files)] };
}

/** Both: docs (when configured) and the task bundle. Logs one line each. */
export async function refreshContext(
  cwd: string,
  config: AgentConfig | null,
  env: KitEnv,
  client: ClickUpClient,
  taskId: string,
  log: (s: string) => void,
): Promise<void> {
  let docsIndex: string | null = null;
  try {
    const docs = await syncDocs(cwd, config, env, client);
    if (docs) {
      docsIndex = `${docs.outDir}/INDEX.md`;
      log(
        `[context] docs: ${docs.pages} page(s) in ${docs.outDir}/ (${docs.written} updated, ${docs.removed} removed)`,
      );
    }
  } catch (e) {
    // Old docs are still there; the run can go on.
    log(`[context] warning: could not sync ClickUp Docs (${(e as Error).message}); using the files from the last sync`);
    const { outDir } = docsSettings(config, env);
    if (existsSync(join(cwd, outDir, 'INDEX.md'))) docsIndex = `${outDir}/INDEX.md`;
  }
  const ctx = await refreshTaskContext(cwd, client, taskId, docsIndex);
  log(`[context] task: ${ctx.files.join(', ')} in ${ctx.dir.replace(/\\/g, '/')}/`);
}
