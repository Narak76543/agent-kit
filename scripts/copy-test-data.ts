/**
 * One-off: copy test data from a SOURCE ClickUp workspace (read only) into a TARGET test workspace,
 * so the kit can be tested without touching real company data.
 *
 * Run with Node 22.18+ / 24 (type stripping), after `pnpm build` (uses packages/core/dist):
 *   node scripts/copy-test-data.ts <command> [options] --source-env <.env> --env <.env>
 *
 * Two tokens, each read only from its own .env file (never from the shell environment):
 *   --source-env  .env with the token that can READ the source workspace. Its client can never write:
 *                 its fence is never opened, so every non-GET request is blocked.
 *   --env         .env with the token for the TARGET test workspace. Its fence is opened for the
 *                 --target workspace only, and only while copying with --yes.
 *
 * Read-only commands (use the source token; add --use target to look at the test workspace):
 *   workspaces                                    workspaces each token can see
 *   docs       --workspace <id>                   docs in a workspace (name, id)
 *   doc-pages  --workspace <id> --doc <docId>     page tree of one doc
 *   lists      --workspace <id>                   lists in a workspace
 *   tasks      --list <listId>                    open tasks in a list
 *
 * Copy commands (always run with --dry-run first, then --yes):
 *   copy-docs  --source <id> --target <id> --docs <docId,docId> [--into-doc <docId>] (--dry-run | --yes)
 *              Without --into-doc: one new doc per source doc in the target workspace.
 *              With --into-doc: one top-level page per source doc inside that existing target doc.
 *   copy-tasks --source <id> --target <id> --tasks <taskId,...> --target-list <listId> (--dry-run | --yes)
 *              Copies name + markdown description only, with status "to do".
 *
 * No IDs or tokens live in this file; pass them as options.
 */
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ClickUpClient, KitError, createLogger, loadEnv } from '../packages/core/dist/index.js';
import type { ClickUpDocPage, ClickUpTask, Logger } from '../packages/core/dist/index.js';
import { fencedFetch, newFence, type Fence } from './write-fence.ts';

interface Doc {
  id: string;
  name: string;
  deleted?: boolean;
  archived?: boolean;
}

interface PlanPage {
  name: string;
  content: string;
  children: PlanPage[];
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    'source-env': { type: 'string' },
    use: { type: 'string', default: 'source' },
    workspace: { type: 'string' },
    doc: { type: 'string' },
    list: { type: 'string' },
    source: { type: 'string' },
    target: { type: 'string' },
    docs: { type: 'string' },
    'into-doc': { type: 'string' },
    tasks: { type: 'string' },
    'target-list': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});

const log: Logger = createLogger();
const print = (s: string) => log.info(s);

// ---------- setup: two clients, two fences ----------

/** The token from one .env file only; the shell environment is ignored on purpose. */
function tokenFrom(option: 'env' | 'source-env'): string {
  const path = opts[option];
  if (!path) throw new KitError(`--${option} <path to .env> is required`);
  const file = resolve(path);
  if (basename(file) !== '.env') throw new KitError(`--${option} must point to a file named .env`);
  const token = loadEnv(dirname(file), {}).CLICKUP_API_TOKEN;
  if (!token) throw new KitError(`no CLICKUP_API_TOKEN in the --${option} file`);
  log.addSecret(token);
  return token;
}

// The source fence is NEVER opened: the source client cannot send a single non-GET request.
const sourceFence: Fence = newFence();
// The target fence is opened for the --target workspace only, right before writing (--yes).
const targetFence: Fence = newFence();

let sourceClient: ClickUpClient | null = null;
let targetClient: ClickUpClient | null = null;

/** Source (read only). */
function src(): ClickUpClient {
  sourceClient ??= new ClickUpClient({ token: tokenFrom('source-env'), fetch: fencedFetch(sourceFence), logger: log });
  return sourceClient;
}

/** Target (test workspace). */
function tgt(): ClickUpClient {
  targetClient ??= new ClickUpClient({ token: tokenFrom('env'), fetch: fencedFetch(targetFence), logger: log });
  return targetClient;
}

/** The client for the read-only commands (--use source|target). */
function reader(): ClickUpClient {
  if (opts.use === 'target') return tgt();
  if (opts.use === 'source') return src();
  throw new KitError('--use must be "source" or "target"');
}

const need = (name: keyof typeof opts): string => {
  const v = opts[name];
  if (typeof v !== 'string' || !v.trim()) throw new KitError(`--${name} is required`);
  return v.trim();
};
const ids = (name: keyof typeof opts) =>
  need(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const enc = (s: string) => encodeURIComponent(s);

const v3 = <T>(
  client: ClickUpClient,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number>,
) => client.request<T>(method, path, { version: 'v3', body, query });

// ---------- reads ----------

async function workspaceNames(client: ClickUpClient): Promise<Map<string, string>> {
  return new Map((await client.getWorkspaces()).map((w) => [w.id, w.name]));
}

async function listDocs(client: ClickUpClient, workspace: string): Promise<Doc[]> {
  const docs: Doc[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await v3<{ docs?: Doc[]; next_cursor?: string }>(
      client,
      'GET',
      `/workspaces/${enc(workspace)}/docs`,
      undefined,
      { limit: 100, ...(cursor ? { cursor } : {}) },
    );
    docs.push(...(page.docs ?? []));
    if (!page.next_cursor || page.next_cursor === cursor || !page.docs?.length) break;
    cursor = page.next_cursor;
  }
  return docs.filter((d) => !d.deleted && !d.archived);
}

const getDoc = (client: ClickUpClient, workspace: string, docId: string) =>
  v3<Doc>(client, 'GET', `/workspaces/${enc(workspace)}/docs/${enc(docId)}`);

async function getPages(client: ClickUpClient, workspace: string, docId: string): Promise<ClickUpDocPage[]> {
  const res = await v3<ClickUpDocPage[] | { pages?: ClickUpDocPage[] }>(
    client,
    'GET',
    `/workspaces/${enc(workspace)}/docs/${enc(docId)}/pages`,
    undefined,
    { max_page_depth: -1, content_format: 'text/md' },
  );
  return Array.isArray(res) ? res : (res.pages ?? []);
}

async function listsIn(client: ClickUpClient, workspace: string): Promise<{ id: string; path: string }[]> {
  const out: { id: string; path: string }[] = [];
  for (const space of await client.getSpaces(workspace)) {
    for (const folder of await client.getFolders(space.id)) {
      for (const l of folder.lists ?? []) out.push({ id: l.id, path: `${space.name} / ${folder.name} / ${l.name}` });
    }
    for (const l of await client.getFolderlessLists(space.id)) {
      out.push({ id: l.id, path: `${space.name} / ${l.name}` });
    }
  }
  return out;
}

/** Page tree without deleted/archived pages (their children are skipped too). */
function toPlan(pages: ClickUpDocPage[]): PlanPage[] {
  return pages
    .filter((p) => !p.deleted && !p.archived)
    .map((p) => ({ name: p.name || '(untitled)', content: p.content ?? '', children: toPlan(p.pages ?? []) }));
}

function printTree(pages: PlanPage[], indent: string): number {
  let n = 0;
  for (const p of pages) {
    print(`${indent}- ${p.name}  (${p.content.length} chars)`);
    n += 1 + printTree(p.children, `${indent}  `);
  }
  return n;
}

// ---------- safety checks before copying ----------

async function checkWorkspaces(source: string, target: string): Promise<{ source: string; target: string }> {
  if (source === target) throw new KitError('--source and --target must be different workspaces');
  const s = await workspaceNames(src());
  const t = await workspaceNames(tgt());
  if (!s.has(source)) throw new KitError(`the --source-env token cannot see source workspace ${source}`);
  if (!t.has(target)) throw new KitError(`the --env token cannot see target workspace ${target}`);
  return { source: s.get(source)!, target: t.get(target)! };
}

function mode(): 'dry-run' | 'yes' {
  if (opts['dry-run'] === opts.yes) throw new KitError('choose exactly one: --dry-run (show the plan) or --yes (copy)');
  return opts.yes ? 'yes' : 'dry-run';
}

// ---------- commands ----------

const commands: Record<string, () => Promise<void>> = {
  async workspaces() {
    for (const [label, client] of [
      ['SOURCE token (--source-env, read only)', src()],
      ['TARGET token (--env, writes allowed only to --target when copying)', tgt()],
    ] as const) {
      const me = await client.getUser();
      print(`${label}: user ${me.username} (id ${me.id})`);
      for (const [id, name] of await workspaceNames(client)) print(`  ${id}  ${name}`);
    }
  },

  async docs() {
    const docs = await listDocs(reader(), need('workspace'));
    for (const d of docs) print(`  ${d.id}  ${d.name}`);
    print(`(${docs.length} docs)`);
  },

  async 'doc-pages'() {
    const client = reader();
    const workspace = need('workspace');
    const doc = await getDoc(client, workspace, need('doc'));
    print(`Doc: ${doc.name} [${doc.id}]`);
    const walk = (pages: ClickUpDocPage[], indent: string) => {
      for (const p of pages) {
        print(`${indent}- ${p.name} [${p.id}]${p.deleted ? ' (deleted)' : ''}${p.archived ? ' (archived)' : ''}`);
        walk(p.pages ?? [], `${indent}  `);
      }
    };
    walk(
      await v3<ClickUpDocPage[]>(
        client,
        'GET',
        `/workspaces/${enc(workspace)}/docs/${enc(doc.id)}/page_listing`,
        undefined,
        {
          max_page_depth: -1,
        },
      ),
      '  ',
    );
  },

  async lists() {
    for (const l of await listsIn(reader(), need('workspace'))) print(`  ${l.id}  ${l.path}`);
  },

  async tasks() {
    const client = reader();
    const listId = need('list');
    const list = await client.getList(listId);
    print(`List: ${list.name} [${list.id}]`);
    for (const t of await client.getListTasks(listId)) print(`  ${t.id}  [${t.status?.status ?? '?'}]  ${t.name}`);
  },

  async 'copy-docs'() {
    const run = mode();
    const source = need('source');
    const target = need('target');
    const names = await checkWorkspaces(source, target);
    const intoDoc = opts['into-doc']?.trim();
    if (intoDoc) await getDoc(tgt(), target, intoDoc); // must exist in the target workspace

    const plans: { doc: Doc; pages: PlanPage[] }[] = [];
    for (const id of ids('docs')) {
      plans.push({ doc: await getDoc(src(), source, id), pages: toPlan(await getPages(src(), source, id)) });
    }

    print(`${run === 'dry-run' ? 'DRY RUN — nothing is created' : 'COPYING'}`);
    print(`From: ${names.source} [${source}] (read only)`);
    print(`To:   ${names.target} [${target}]${intoDoc ? `, into existing doc ${intoDoc}` : ', as new docs'}`);
    let total = 0;
    for (const { doc, pages } of plans) {
      print(intoDoc ? `\n+ page "${doc.name}" (top level in the target doc)` : `\n+ new doc "${doc.name}"`);
      total += printTree(pages, '    ');
    }
    print(`\n${plans.length} doc(s), ${total} page(s)${intoDoc ? ` + ${plans.length} top-level page(s)` : ''}.`);
    if (run === 'dry-run') return print('Run again with --yes instead of --dry-run to copy.');

    targetFence.targetWorkspace = target;
    for (const { doc, pages } of plans) {
      let docId: string;
      let parentPageId: string | undefined;
      if (intoDoc) {
        docId = intoDoc;
        parentPageId = await createPage(target, docId, undefined, { name: doc.name, content: '', children: [] });
        print(`created page "${doc.name}" [${parentPageId}]`);
      } else {
        const created = await v3<{ id: string }>(tgt(), 'POST', `/workspaces/${enc(target)}/docs`, {
          name: doc.name,
          parent: { id: target, type: 12 }, // 12 = Workspace (official PublicDocsParentDto)
          visibility: 'PRIVATE',
          create_page: false,
        });
        docId = created.id;
        print(`created doc "${doc.name}" [${docId}]`);
      }
      await createPages(target, docId, parentPageId, pages);
    }
    print('Done.');
  },

  async 'copy-tasks'() {
    const run = mode();
    const source = need('source');
    const target = need('target');
    const names = await checkWorkspaces(source, target);
    const targetListId = need('target-list');
    const targetLists = await listsIn(tgt(), target);
    const targetList = targetLists.find((l) => l.id === targetListId);
    if (!targetList) throw new KitError(`list ${targetListId} is not in the target workspace ${target}`);
    const todo = (await tgt().getList(targetListId)).statuses?.find((s) => s.status.trim().toLowerCase() === 'to do');
    if (!todo) throw new KitError('the target list has no "to do" status; add it in ClickUp first');

    const tasks: ClickUpTask[] = [];
    for (const id of ids('tasks')) tasks.push(await src().getTask(id, { subtasks: false }));
    const sourceListIds = new Set((await listsIn(src(), source)).map((l) => l.id));
    for (const t of tasks) {
      if (!t.list?.id || !sourceListIds.has(t.list.id))
        throw new KitError(`task ${t.id} is not in the source workspace`);
    }

    print(`${run === 'dry-run' ? 'DRY RUN — nothing is created' : 'COPYING'}`);
    print(`From: ${names.source} [${source}] (read only)`);
    print(`To:   ${names.target} [${target}] / ${targetList.path} [${targetListId}], status "${todo.status}"`);
    for (const t of tasks) {
      const desc = t.markdown_description || t.text_content || '';
      print(`  + "${t.name}"  (from ${t.id}, description ${desc.length} chars; no comments, assignees or attachments)`);
    }
    if (run === 'dry-run') return print('Run again with --yes instead of --dry-run to copy.');

    targetFence.targetWorkspace = target;
    targetFence.targetLists = new Set(targetLists.map((l) => l.id));
    for (const t of tasks) {
      const created = await tgt().request<{ id: string; url?: string }>('POST', `/list/${enc(targetListId)}/task`, {
        // Official Create Task field is markdown_content (markdown_description is not part of the API).
        body: { name: t.name, markdown_content: t.markdown_description || t.text_content || '', status: todo.status },
      });
      print(`created task "${t.name}" [${created.id}] ${created.url ?? ''}`);
    }
    print('Done.');
  },
};

async function createPage(
  workspace: string,
  docId: string,
  parentId: string | undefined,
  page: PlanPage,
): Promise<string> {
  const created = await v3<{ id: string }>(tgt(), 'POST', `/workspaces/${enc(workspace)}/docs/${enc(docId)}/pages`, {
    ...(parentId ? { parent_page_id: parentId } : {}),
    name: page.name,
    content: page.content,
    content_format: 'text/md',
  });
  return created.id;
}

/** Parents before children, in source order, so titles and order are kept. */
async function createPages(workspace: string, docId: string, parentId: string | undefined, pages: PlanPage[]) {
  for (const page of pages) {
    const id = await createPage(workspace, docId, parentId, page);
    print(`  created page "${page.name}" [${id}]`);
    await createPages(workspace, docId, id, page.children);
  }
}

async function main() {
  const [cmd] = positionals;
  const run = cmd ? commands[cmd] : undefined;
  if (!run) {
    print(
      `Usage: node scripts/copy-test-data.ts <${Object.keys(commands).join(' | ')}> --source-env <.env> --env <.env> [options]`,
    );
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  await run();
}

// Set exitCode instead of process.exit(): exiting during a fetch crashes Node on Windows.
main().catch((e: unknown) => {
  const violations = [...sourceFence.violations, ...targetFence.violations];
  if (violations.length) {
    log.error(`SAFETY STOP: ${violations.join('; ')}`);
    process.exitCode = 3;
    return;
  }
  log.error(`ERROR: ${(e as Error).message}`);
  process.exitCode = 1;
});
