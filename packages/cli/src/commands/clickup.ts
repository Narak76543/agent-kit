/**
 * `tossana-agents clickup …`: the only way agents talk to ClickUp. Ported from
 * EKMONG_MOBILE scripts/clickup.ts; `status` now takes role names instead of raw status names.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  DEFAULT_STATUSES,
  DoneGuardError,
  FORBIDDEN_WORDS,
  KitError,
  ROLES,
  appendHandoff,
  canAgentSet,
  docsSettings,
  isRole,
  isValidTaskId,
  statusForRole,
  type ClickUpClient,
  type ClickUpDocPage,
  type Role,
} from '@tossana/agents-core';
import { createClient, loadProject, requireConfig, type CliContext, type Project } from '../context.js';

interface TextOptions {
  file?: string;
}

export function registerClickupCommands(program: Command, ctx: CliContext): void {
  const cu = program
    .command('clickup')
    .description('ClickUp commands used by the agents (REST API, your own token from .env)');

  const setup = () => {
    const project = loadProject(ctx);
    return { project, client: createClient(ctx, project) };
  };
  const print = (text: string) => ctx.logger.info(text);
  const printJson = (value: unknown) => print(JSON.stringify(value, null, 2));

  cu.command('get <taskId>')
    .description('task details as JSON')
    .action(async (taskId: string) => {
      const t = await setup().client.getTask(taskId);
      printJson({
        id: t.id,
        custom_id: t.custom_id,
        name: t.name,
        status: t.status?.status,
        url: t.url,
        list: { id: t.list?.id, name: t.list?.name },
        parent: t.parent,
        assignees: (t.assignees ?? []).map((a) => a.username),
        priority: t.priority?.priority ?? null,
        due_date: t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
        tags: (t.tags ?? []).map((x) => x.name),
        description: t.markdown_description || t.text_content || t.description || '',
        subtasks: (t.subtasks ?? []).map((s) => ({ id: s.id, name: s.name, status: s.status?.status })),
      });
    });

  cu.command('comments <taskId>')
    .description('all comments, oldest first')
    .action(async (taskId: string) => {
      const all = await setup().client.getComments(taskId);
      for (const c of all) {
        print(`--- ${new Date(Number(c.date)).toISOString()} · ${c.user?.username ?? 'unknown'} · id ${c.id}`);
        print(c.comment_text ?? '');
      }
      if (!all.length) print('(no comments)');
    });

  cu.command('comment <taskId> [text...]')
    .description('post a comment and append it to .agents/handoff/<taskId>.md (text, --file <path>, or - for stdin)')
    .option('--file <path>', 'read the comment text from a file')
    .action(async (taskId: string, words: string[], opts: TextOptions) => {
      const text = await readText(ctx, words, opts, 'comment <taskId> "<text>" | --file <path> | -');
      await setup().client.postComment(taskId, text);
      if (isValidTaskId(taskId)) appendHandoff(ctx.cwd, taskId, 'ClickUp comment', text, ctx.now());
      removeAgentTempFile(ctx, opts);
      print(`OK: comment posted on ${taskId}`);
    });

  cu.command('notify <taskId> [text...]')
    .description('comment assigned to CLICKUP_OWNER_USER_ID, so the owner gets a notification')
    .option('--file <path>', 'read the text from a file')
    .action(async (taskId: string, words: string[], opts: TextOptions) => {
      const text = await readText(ctx, words, opts, 'notify <taskId> "<text>" | --file <path> | -');
      const { project, client } = setup();
      await client.notify(taskId, text, project.env.CLICKUP_OWNER_USER_ID ?? '');
      if (isValidTaskId(taskId)) appendHandoff(ctx.cwd, taskId, 'Owner notified', text, ctx.now());
      removeAgentTempFile(ctx, opts);
      print(`OK: owner notified on ${taskId}`);
    });

  cu.command('handoff <taskId> [text...]')
    .description('append notes to .agents/handoff/<taskId>.md (local only, no API call)')
    .option('--file <path>', 'read the text from a file')
    .action(async (taskId: string, words: string[], opts: TextOptions) => {
      if (!isValidTaskId(taskId)) throw new KitError(`invalid task id "${taskId}"`);
      const text = await readText(ctx, words, opts, 'handoff <taskId> "<text>" | --file <path> | -');
      const file = appendHandoff(ctx.cwd, taskId, 'Notes', text, ctx.now());
      removeAgentTempFile(ctx, opts);
      print(`OK: appended to ${relative(ctx.cwd, file)}`);
    });

  cu.command('status <taskId> <role...>')
    .description(`move a task to a role's status (${ROLES.join(', ')}). Never Done.`)
    .action(async (taskId: string, roleWords: string[]) => {
      const role = resolveRole(roleWords.join(' '));
      const { project, client } = setup();
      const change = await client.setStatus(taskId, statusName(project, role));
      print(`OK: ${taskId} ${change.from ?? '?'} -> ${change.to}`);
    });

  cu.command('subtask <taskId> <name> [description...]')
    .description('create a subtask')
    .action(async (taskId: string, name: string, description: string[]) => {
      const created = await setup().client.createSubtask(taskId, name, description.join(' ').replace(/\\n/g, '\n'));
      printJson({ id: created.id, name: created.name, url: created.url });
    });

  cu.command('list')
    .description('tasks in the project list')
    .option('--status <role>', `only tasks in this role's status (${ROLES.join(', ')})`)
    .option('--mine', 'only tasks assigned to me (the token owner)')
    .option('--list <listId>', 'another list instead of clickup.listId')
    .option('--json', 'print JSON')
    .action(async (opts: { status?: string; mine?: boolean; list?: string; json?: boolean }) => {
      const { project, client } = setup();
      const listId = opts.list ?? requireConfig(project).clickup.listId;
      const tasks = await listTasks(client, project, listId, opts);
      const rows = tasks.map((t) => ({ id: t.id, name: t.name, status: t.status?.status, url: t.url }));
      if (opts.json) return printJson(rows);
      for (const r of rows) print(`${r.id}\t${r.status}\t${r.name}`);
      if (!rows.length) print('(no tasks)');
    });

  cu.command('spaces')
    .description('your workspaces and spaces, with IDs')
    .action(async () => {
      const { client } = setup();
      const me = await client.getUser();
      print(`Token user: ${me.username} (user id ${me.id}) — use as CLICKUP_OWNER_USER_ID if this is you\n`);
      for (const team of await client.getWorkspaces()) {
        print(`Workspace: ${team.name}  [workspaceId ${team.id}]`);
        for (const space of await client.getSpaces(team.id)) print(`  Space: ${space.name}  [${space.id}]`);
      }
    });

  cu.command('lists')
    .description('workspace → space → folder → list tree, with list IDs')
    .action(async () => {
      const { client } = setup();
      for (const team of await client.getWorkspaces()) {
        print(`Workspace: ${team.name}  [workspaceId ${team.id}]`);
        for (const space of await client.getSpaces(team.id)) {
          print(`  Space: ${space.name}  [${space.id}]`);
          for (const folder of await client.getFolders(space.id)) {
            print(`    Folder: ${folder.name}  [${folder.id}]`);
            for (const l of folder.lists ?? []) print(`      List: ${l.name}  [listId ${l.id}]`);
          }
          for (const l of await client.getFolderlessLists(space.id)) print(`    List: ${l.name}  [listId ${l.id}]`);
        }
      }
    });

  cu.command('statuses [listId]')
    .description("a list's statuses, which role each one has, and which agents may set")
    .action(async (listIdArg: string | undefined) => {
      const { project, client } = setup();
      const listId = listIdArg ?? requireConfig(project).clickup.listId;
      const list = await client.getList(listId);
      const roleOf = new Map<string, Role>();
      if (project.config) for (const r of ROLES) roleOf.set(statusForRole(project.config, r).toLowerCase(), r);
      print(`List: ${list.name} [${list.id}]`);
      for (const s of list.statuses ?? []) {
        const who = canAgentSet(s, client.agentStatuses) ? 'agent can set' : 'HUMAN ONLY';
        const role = roleOf.get(s.status.toLowerCase());
        print(
          `  ${s.status.padEnd(22)} type=${String(s.type).padEnd(8)} ${who.padEnd(14)}${role ? ` role=${role}` : ''}`,
        );
      }
      const names = (list.statuses ?? []).map((s) => s.status.toLowerCase());
      const missing = client.agentStatuses.filter((a) => !names.includes(a.toLowerCase()));
      if (missing.length) print(`\nWARNING: missing statuses the agents need: ${missing.join(', ')}`);
    });

  cu.command('sync-docs')
    .description('pull ClickUp Docs (clickup.docs.ids) into markdown files the agents can read')
    .action(async () => {
      const { project, client } = setup();
      const { ids, outDir } = docsSettings(project.config, project.env);
      if (!ids.length) throw new KitError('no ClickUp Doc IDs: set clickup.docs.ids in agent.config.json');
      const files = collectDocFiles(await Promise.all(ids.map((id) => client.getDocPages(id))));
      // Only replace the folder after every download succeeded.
      const out = resolve(ctx.cwd, outDir);
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      for (const f of files) writeFileSync(join(out, f.file), f.content);
      writeFileSync(
        join(out, 'INDEX.md'),
        `# ClickUp docs (synced ${ctx.now().toISOString()})\n\nDo not edit by hand. Run: tossana-agents clickup sync-docs\n\n` +
          `${files.map((f) => `- [${f.name}](./${f.file})`).join('\n')}\n`,
      );
      print(`OK: synced ${files.length} pages into ${outDir}/`);
    });
}

/** Text from words, `--file <path>` (relative to the project), or `-` (stdin). Literal "\n" becomes a newline. */
async function readText(ctx: CliContext, words: string[], opts: TextOptions, usage: string): Promise<string> {
  let text: string;
  if (opts.file) text = readFileSync(resolve(ctx.cwd, opts.file), 'utf8');
  else if (words.length === 1 && words[0] === '-') text = await ctx.io.readStdin();
  else text = words.join(' ').replace(/\\n/g, '\n');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM from Windows editors
  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) throw new KitError(`usage: ${usage}`);
  return text;
}

function resolveRole(input: string): Role {
  const value = input.trim().toLowerCase();
  // Same message and exit code 2 as the guard, before anything else happens.
  const word = FORBIDDEN_WORDS.find((w) => value.includes(w));
  if (word) throw new DoneGuardError(input, `"${input}" contains a forbidden word (${FORBIDDEN_WORDS.join('/')})`);
  if (!isRole(value)) throw new KitError(`unknown role "${input}". Use one of: ${ROLES.join(', ')}`);
  return value;
}

async function listTasks(
  client: ClickUpClient,
  project: Project,
  listId: string,
  opts: { status?: string; mine?: boolean },
) {
  const statuses = opts.status ? [statusName(project, resolveRole(opts.status))] : undefined;
  const assignees = opts.mine ? [(await client.getUser()).id] : undefined;
  return client.getListTasks(listId, { statuses, assignees });
}

function statusName(project: Project, role: Role): string {
  return project.config ? statusForRole(project.config, role) : DEFAULT_STATUSES[role];
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
      files.push({ file, name, content: `# ${name}\n\n${p.content ?? ''}\n` });
      if (p.pages?.length) walk(p.pages, `${base}__`);
    }
  };
  for (const pages of docs) walk(pages, '');
  return files;
}

/** Agents write comment text to .agents/tmp/ (no shell quoting); remove it once it has been used. */
export const AGENT_TMP_DIR = join('.agents', 'tmp');

function removeAgentTempFile(ctx: CliContext, opts: TextOptions): void {
  if (!opts.file) return;
  const file = resolve(ctx.cwd, opts.file);
  const rel = relative(resolve(ctx.cwd, AGENT_TMP_DIR), file);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) rmSync(file, { force: true });
}
