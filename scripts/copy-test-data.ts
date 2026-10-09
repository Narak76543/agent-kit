/**
 * One-off: copy test data from a SOURCE ClickUp workspace (read only) into a TARGET test workspace,
 * so the kit can be tested without touching real company data.
 *
 * Run with Node 22.18+ / 24 (type stripping), after `pnpm build` (uses packages/core/dist):
 *   node scripts/copy-test-data.ts <command> [options] --env <path to .env with CLICKUP_API_TOKEN>
 *
 * Read-only commands:
 *   workspaces                                    workspaces the token can see
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
 * SAFETY: every request that is not a GET goes through `writeFence`, which stops the script unless the
 * request targets the --target workspace (v3: workspace ID in the URL; v2: a list that belongs to the
 * target workspace). No IDs or tokens live in this file; pass them as options.
 */
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ClickUpClient, KitError, createLogger, loadEnv } from '../packages/core/dist/index.js';
import type { ClickUpDocPage, ClickUpTask, Logger } from '../packages/core/dist/index.js';
import { fencedFetch, newFence } from './write-fence.ts';

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
    env: { type: 'string', default: '.env' },
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

// ---------- setup ----------

// Every non-GET request passes the fence; it is opened for the target workspace only when copying.
const fence = newFence();

const envFile = resolve(opts.env!);
if (basename(envFile) !== '.env') throw new KitError('--env must point to a file named .env');
const env = loadEnv(dirname(envFile));
log.addSecret(env.CLICKUP_API_TOKEN);
// The limiter waits on 429s; its notes go to stderr, redacted.
const client = new ClickUpClient({ token: env.CLICKUP_API_TOKEN ?? '', fetch: fencedFetch(fence), logger: log });

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

const v3 = <T>(method: string, path: string, body?: unknown, query?: Record<string, string | number>) =>
  client.request<T>(method, path, { version: 'v3', body, query });

// ---------- reads ----------

async function workspaceIds(): Promise<Map<string, string>> {
  return new Map((await client.getWorkspaces()).map((w) => [w.id, w.name]));
}

async function listDocs(workspace: string): Promise<Doc[]> {
  const docs: Doc[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await v3<{ docs?: Doc[]; next_cursor?: string }>(
      'GET',
      `/workspaces/${enc(workspace)}/docs`,
      undefined,
      {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
    );
    docs.push(...(page.docs ?? []));
    if (!page.next_cursor || page.next_cursor === cursor || !page.docs?.length) break;
    cursor = page.next_cursor;
  }
  return docs.filter((d) => !d.deleted && !d.archived);
}

const getDoc = (workspace: string, docId: string) => v3<Doc>('GET', `/workspaces/${enc(workspace)}/docs/${enc(docId)}`);

const getPages = async (workspace: string, docId: string) => {
  const res = await v3<ClickUpDocPage[] | { pages?: ClickUpDocPage[] }>(
    'GET',
    `/workspaces/${enc(workspace)}/docs/${enc(docId)}/pages`,
    undefined,
    { max_page_depth: -1, content_format: 'text/md' },
  );
  return Array.isArray(res) ? res : (res.pages ?? []);
};

async function listsIn(workspace: string): Promise<{ id: string; path: string }[]> {
  const out: { id: string; path: string }[] = [];
  for (const space of await client.getSpaces(workspace)) {
    for (const folder of await client.getFolders(space.id)) {
      for (const l of folder.lists ?? []) out.push({ id: l.id, path: `${space.name} / ${folder.name} / ${l.name}` });
    }
    for (const l of await client.getFolderlessLists(space.id))
      out.push({ id: l.id, path: `${space.name} / ${l.name}` });
  }
  return out;
}

const enc = (s: string) => encodeURIComponent(s);

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

async function checkWorkspaces(source: string, target: string): Promise<Map<string, string>> {
  if (source === target) throw new KitError('--source and --target must be different workspaces');
  const all = await workspaceIds();
  if (!all.has(source)) throw new KitError(`the token cannot see source workspace ${source}`);
  if (!all.has(target)) throw new KitError(`the token cannot see target workspace ${target}`);
  return all;
}

function mode(): 'dry-run' | 'yes' {
  if (opts['dry-run'] === opts.yes) throw new KitError('choose exactly one: --dry-run (show the plan) or --yes (copy)');
  return opts.yes ? 'yes' : 'dry-run';
}

// ---------- commands ----------

const commands: Record<string, () => Promise<void>> = {
  async workspaces() {
    const me = await client.getUser();
    print(`Token user: ${me.username} (id ${me.id})`);
    for (const [id, name] of await workspaceIds()) print(`  ${id}  ${name}`);
  },

  async docs() {
    const workspace = need('workspace');
    const docs = await listDocs(workspace);
    for (const d of docs) print(`  ${d.id}  ${d.name}`);
    print(`(${docs.length} docs)`);
  },

  async 'doc-pages'() {
    const workspace = need('workspace');
    const doc = await getDoc(workspace, need('doc'));
    print(`Doc: ${doc.name} [${doc.id}]`);
    const walk = (pages: ClickUpDocPage[], indent: string) => {
      for (const p of pages) {
        print(`${indent}- ${p.name} [${p.id}]${p.deleted ? ' (deleted)' : ''}${p.archived ? ' (archived)' : ''}`);
        walk(p.pages ?? [], `${indent}  `);
      }
    };
    walk(
      await v3<ClickUpDocPage[]>('GET', `/workspaces/${enc(workspace)}/docs/${enc(doc.id)}/page_listing`, undefined, {
        max_page_depth: -1,
      }),
      '  ',
    );
  },

  async lists() {
    for (const l of await listsIn(need('workspace'))) print(`  ${l.id}  ${l.path}`);
  },

  async tasks() {
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
    if (intoDoc) await getDoc(target, intoDoc); // must exist in the target workspace

    const plans: { doc: Doc; pages: PlanPage[] }[] = [];
    for (const id of ids('docs'))
      plans.push({ doc: await getDoc(source, id), pages: toPlan(await getPages(source, id)) });

    print(`${run === 'dry-run' ? 'DRY RUN — nothing is created' : 'COPYING'}`);
    print(`From: ${names.get(source)} [${source}] (read only)`);
    print(`To:   ${names.get(target)} [${target}]${intoDoc ? `, into existing doc ${intoDoc}` : ', as new docs'}`);
    let total = 0;
    for (const { doc, pages } of plans) {
      print(intoDoc ? `\n+ page "${doc.name}" (top level in the target doc)` : `\n+ new doc "${doc.name}"`);
      total += printTree(pages, '    ');
    }
    print(`\n${plans.length} doc(s), ${total} page(s)${intoDoc ? ` + ${plans.length} top-level page(s)` : ''}.`);
    if (run === 'dry-run') return print('Run again with --yes instead of --dry-run to copy.');

    fence.targetWorkspace = target;
    for (const { doc, pages } of plans) {
      let docId: string;
      let parentPageId: string | undefined;
      if (intoDoc) {
        docId = intoDoc;
        const top = await createPage(target, docId, undefined, { name: doc.name, content: '', children: [] });
        parentPageId = top;
      } else {
        const created = await v3<{ id: string }>('POST', `/workspaces/${enc(target)}/docs`, {
          name: doc.name,
          parent: { id: target, type: 12 },
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
    const targetLists = await listsIn(target);
    const targetList = targetLists.find((l) => l.id === targetListId);
    if (!targetList) throw new KitError(`list ${targetListId} is not in the target workspace ${target}`);
    const todo = (await client.getList(targetListId)).statuses?.find((s) => s.status.trim().toLowerCase() === 'to do');
    if (!todo) throw new KitError(`the target list has no "to do" status; add it in ClickUp first`);

    const tasks: ClickUpTask[] = [];
    for (const id of ids('tasks')) tasks.push(await client.getTask(id, { subtasks: false }));
    const sourceListIds = new Set((await listsIn(source)).map((l) => l.id));
    for (const t of tasks) {
      if (!t.list?.id || !sourceListIds.has(t.list.id))
        throw new KitError(`task ${t.id} is not in the source workspace`);
    }

    print(`${run === 'dry-run' ? 'DRY RUN — nothing is created' : 'COPYING'}`);
    print(`From: ${names.get(source)} [${source}] (read only)`);
    print(`To:   ${names.get(target)} [${target}] / ${targetList.path} [${targetListId}], status "${todo.status}"`);
    for (const t of tasks) {
      const desc = t.markdown_description || t.text_content || '';
      print(`  + "${t.name}"  (from ${t.id}, description ${desc.length} chars; no comments, assignees or attachments)`);
    }
    if (run === 'dry-run') return print('Run again with --yes instead of --dry-run to copy.');

    fence.targetWorkspace = target;
    fence.targetLists = new Set(targetLists.map((l) => l.id));
    for (const t of tasks) {
      const created = await client.request<{ id: string; url?: string }>('POST', `/list/${enc(targetListId)}/task`, {
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
  const created = await v3<{ id: string }>('POST', `/workspaces/${enc(workspace)}/docs/${enc(docId)}/pages`, {
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
    print(`Usage: node scripts/copy-test-data.ts <${Object.keys(commands).join(' | ')}> [options] --env <path>`);
    process.exitCode = cmd ? 1 : 0;
    return;
  }
  if (!env.CLICKUP_API_TOKEN) throw new KitError(`no CLICKUP_API_TOKEN in ${opts.env}`);
  await run();
}

// Set exitCode instead of process.exit(): exiting during a fetch crashes Node on Windows.
main().catch((e: unknown) => {
  if (fence.violations.length) {
    log.error(`SAFETY STOP: ${fence.violations.join('; ')}`);
    process.exitCode = 3;
    return;
  }
  log.error(`ERROR: ${(e as Error).message}`);
  process.exitCode = 1;
});
