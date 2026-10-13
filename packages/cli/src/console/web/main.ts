/**
 * Local Console page (browser code, bundled by esbuild into dist/console.html). No framework: three screens.
 * - The session token comes from this page's URL and is sent as `Authorization: Bearer` on every API call.
 * - All text is set with textContent (never innerHTML), so task names or log lines cannot inject markup.
 */

// ---------- types (what the server sends) ----------

type CheckStatus = 'ok' | 'fail' | 'warn' | 'skip';
interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
  hint?: string;
}
type RunState = 'running' | 'done' | 'failed' | 'stopped';
interface RunInfo {
  id: number;
  taskId: string;
  mode: 'run' | 'resume';
  runner: string;
  state: RunState;
  startedAt: string;
  lineCount: number;
}
interface ProjectInfo {
  kitVersion: string;
  cwd: string;
  configError?: string;
  project: {
    name: string;
    listId: string;
    baseBranch: string;
    tools: string[];
    runners: string[];
    defaultRunner: string | null;
  } | null;
  run: RunInfo | null;
}
interface Task {
  id: string;
  customId: string | null;
  name: string;
  status: string;
  role: string | null;
  url: string | null;
  branchExists: boolean;
  action: 'run' | 'resume' | null;
  note?: string;
}
interface Preview {
  previewId: string;
  output: string;
  needsWipCommit: boolean;
  dirty: string;
  warnings: string[];
  busy: string | null;
}
interface RunStatus {
  name: string;
  status: string;
  role: string | null;
  round: number | null;
  rounds: number;
  lastAgent: string | null;
  lastResult: string | null;
  lastSummary: string | null;
  handoff: string | null;
}
type RunEvent = { type: 'line'; index: number; text: string } | { type: 'state'; state: RunState };

// ---------- API ----------

const TOKEN = new URLSearchParams(location.search).get('token') ?? '';

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly data: Record<string, unknown>,
  ) {
    super(typeof data.error === 'string' ? data.error : `HTTP ${status}`);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

// ---------- tiny DOM helper ----------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void) | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const $ = (id: string) => document.getElementById(id)!;
const badge = (text: string, kind = '') => h('span', { class: `badge ${kind}` }, text);
const errorBox = (e: unknown) =>
  h(
    'div',
    { class: 'notice bad', role: 'alert' },
    (e as Error).message,
    e instanceof ApiError && typeof e.data.fix === 'string' ? ` FIX: ${e.data.fix}` : '',
  );

// ---------- theme (same key and default as the Team Dashboard) ----------

const THEME_KEY = 'tossana-theme';
function renderThemeToggle() {
  const btn = $('theme-toggle');
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  btn.textContent = theme === 'dark' ? '☾ Dark' : '☀ Light';
  btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
}
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // blocked storage: still switches for this visit
  }
  renderThemeToggle();
});

// ---------- state + tabs ----------

type Tab = 'health' | 'tasks' | 'run';
const state: { project: ProjectInfo | null; run: RunInfo | null; runner: string | null; tab: Tab } = {
  project: null,
  run: null,
  runner: null,
  tab: 'health',
};
const loaded = new Set<Tab>();

function showTab(tab: Tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const t of ['health', 'tasks', 'run'] as Tab[]) $(`screen-${t}`).hidden = t !== tab;
  if (!loaded.has(tab)) {
    loaded.add(tab);
    if (tab === 'health') void loadHealth();
    if (tab === 'tasks') void loadTasks();
    if (tab === 'run') renderRun();
  }
  history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tab'))
  b.addEventListener('click', () => showTab(b.dataset.tab as Tab));

function setRun(run: RunInfo | null) {
  state.run = run;
  $('run-dot').hidden = run?.state !== 'running';
}
const running = () => state.run?.state === 'running';

// ---------- 1. Project health ----------

const STATUS: Record<CheckStatus, { label: string; kind: string; icon: string }> = {
  ok: { label: 'OK', kind: 'ok', icon: '✓' },
  fail: { label: 'Failed', kind: 'bad', icon: '✕' },
  warn: { label: 'Warning', kind: 'warn', icon: '!' },
  skip: { label: 'Skipped', kind: '', icon: '–' },
};

async function loadHealth() {
  const root = $('screen-health');
  const button = h('button', { type: 'button', class: 'btn', onclick: () => void loadHealth() }, 'Re-check');
  const head = h(
    'div',
    { class: 'screen-head' },
    h(
      'div',
      {},
      h('h1', {}, 'Project health'),
      h('p', { class: 'muted small' }, 'The same checks as "tossana-agents doctor". Fix the first failed one first.'),
    ),
    button,
  );
  button.disabled = true;
  button.textContent = 'Checking…';
  root.replaceChildren(head, h('p', { class: 'muted' }, 'Running the checks…'));
  try {
    const { checks } = await api<{ checks: Check[] }>('/api/doctor');
    const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
    const summary = h(
      'div',
      { class: 'summary' },
      badge(`${count('ok')} ok`, 'ok'),
      count('fail') ? badge(`${count('fail')} failed`, 'bad') : null,
      count('warn') ? badge(`${count('warn')} warnings`, 'warn') : null,
      count('skip') ? badge(`${count('skip')} skipped`) : null,
    );
    const cards = checks.map((c) => {
      const s = STATUS[c.status];
      return h(
        'div',
        { class: `card check${c.status === 'fail' ? ' bad' : ''}` },
        h('span', { class: `badge ${s.kind}`, title: s.label, 'aria-label': s.label }, s.icon),
        h('h3', {}, c.name),
        c.detail ? h('div', { class: 'detail' }, c.detail) : null,
        c.fix && c.status !== 'ok' ? h('div', { class: 'fix' }, h('b', {}, 'Fix: '), c.fix) : null,
        c.hint && c.status !== 'ok' ? h('div', { class: 'hint muted' }, h('b', {}, 'Hint: '), c.hint) : null,
      );
    });
    root.replaceChildren(head, summary, h('div', { class: 'grid' }, ...cards));
  } catch (e) {
    root.replaceChildren(head, errorBox(e));
  }
  button.disabled = false;
  button.textContent = 'Re-check';
}

// ---------- 2. My tasks ----------

const ROLE_KIND: Record<string, string> = {
  todo: 'info',
  coding: 'warn',
  review: 'warn',
  testing: 'warn',
  human: 'ok',
};

async function loadTasks() {
  const root = $('screen-tasks');
  const p = state.project?.project;
  const refresh = h('button', { type: 'button', class: 'btn', onclick: () => void loadTasks() }, 'Refresh');
  const select = h('select', {
    'aria-label': 'Runner',
    onchange: (e) => (state.runner = (e.target as HTMLSelectElement).value),
  });
  for (const r of p?.runners ?? []) select.append(h('option', { value: r, selected: r === state.runner }, r));
  const head = h(
    'div',
    { class: 'screen-head' },
    h(
      'div',
      {},
      h('h1', {}, 'My tasks'),
      h('p', { class: 'muted small' }, p ? `Assigned to you in list ${p.listId}.` : ''),
    ),
    h('div', { class: 'row' }, h('label', { class: 'muted small' }, 'Runner'), select, refresh),
  );
  if (!p) {
    root.replaceChildren(
      head,
      h(
        'div',
        { class: 'notice bad' },
        state.project?.configError ?? 'agent.config.json not found. Run: tossana-agents init',
      ),
    );
    return;
  }
  if (!p.runners.length) {
    root.replaceChildren(
      head,
      h(
        'div',
        { class: 'notice' },
        'No runner is set up in this project. Add a tool with: tossana-agents init --tools …',
      ),
    );
    return;
  }
  root.replaceChildren(head, h('p', { class: 'muted' }, 'Loading tasks from ClickUp…'));
  try {
    const { tasks } = await api<{ tasks: Task[] }>('/api/tasks');
    if (!tasks.length) {
      root.replaceChildren(head, h('div', { class: 'card empty' }, 'No tasks assigned to you in the agent statuses.'));
      return;
    }
    const rows = tasks.map((t) => {
      const action = t.action
        ? h(
            'button',
            {
              type: 'button',
              class: `btn${t.action === 'run' ? ' primary' : ''}`,
              disabled: running(),
              title: running() ? 'A run is already going' : undefined,
              onclick: () => void openPreview(t, t.action!),
            },
            t.action === 'run' ? 'Run' : 'Resume',
          )
        : null;
      return h(
        'div',
        { class: 'card task' },
        h(
          'div',
          { class: 'task-main' },
          h('div', { class: 'task-name' }, t.name),
          h(
            'div',
            { class: 'task-meta' },
            h('span', { class: 'mono' }, t.customId ?? t.id),
            badge(t.status, ROLE_KIND[t.role ?? ''] ?? ''),
            t.branchExists ? h('span', {}, 'task branch ✓') : null,
            t.url ? h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in ClickUp') : null,
          ),
          t.note ? h('div', { class: 'muted small' }, t.note) : null,
        ),
        h('div', { class: 'task-actions' }, action),
      );
    });
    root.replaceChildren(head, h('div', { class: 'stack' }, ...rows));
  } catch (e) {
    root.replaceChildren(head, errorBox(e));
  }
}

/** Dry-run preview, then the user confirms (and, for leftover changes, ticks the WIP commit). */
async function openPreview(task: Task, mode: 'run' | 'resume') {
  const dialog = $('dialog') as HTMLDialogElement;
  const runner = state.runner ?? state.project?.project?.defaultRunner ?? '';
  const body = h('div', { class: 'dialog-body' });
  const title = h(
    'h2',
    { id: 'dialog-title' },
    `${mode === 'run' ? 'Run' : 'Resume'} ${task.customId ?? task.id} with ${runner}`,
  );
  const close = () => dialog.close();
  body.replaceChildren(title, h('p', { class: 'muted' }, 'Preparing the dry run…'));
  dialog.replaceChildren(body);
  dialog.showModal();

  let preview: Preview;
  try {
    preview = await api<Preview>('/api/preview', { taskId: task.id, mode, runner });
  } catch (e) {
    body.replaceChildren(
      title,
      errorBox(e),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Close')),
    );
    return;
  }

  const wip = preview.needsWipCommit ? h('input', { type: 'checkbox', id: 'confirm-wip' }) : null;
  const start = h('button', { type: 'button', class: 'btn primary' }, mode === 'run' ? 'Start run' : 'Resume run');
  const problem = h('div', { class: 'notice bad', hidden: true, role: 'alert' });
  start.disabled = !!preview.busy || !!wip;
  wip?.addEventListener('change', () => (start.disabled = !!preview.busy || !wip.checked));
  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      const run = await api<RunInfo>('/api/runs', { previewId: preview.previewId, confirmWip: wip?.checked ?? false });
      close();
      setRun(run);
      showTab('run');
      renderRun();
    } catch (e) {
      problem.hidden = false;
      problem.textContent = (e as Error).message;
    }
  });

  const parts: Child[] = [
    title,
    h('p', { class: 'small muted' }, 'Dry run: this is exactly what will happen. Nothing has changed yet.'),
    h('pre', { class: 'preview mono' }, preview.output),
    preview.busy ? h('div', { class: 'notice' }, preview.busy) : null,
    ...preview.warnings.map((w) => h('div', { class: 'notice' }, w)),
    wip
      ? h(
          'div',
          { class: 'stack' },
          h('div', { class: 'notice' }, 'The task branch has uncommitted changes from the previous tool:'),
          h('pre', { class: 'preview mono' }, preview.dirty),
          h(
            'label',
            { class: 'confirm', for: 'confirm-wip' },
            wip,
            'Commit these changes as "WIP: handoff from …" before resuming',
          ),
        )
      : null,
    problem,
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      start,
    ),
  ];
  body.replaceChildren(...parts.filter((p): p is Node | string => !!p));
}

// ---------- 3. Live run ----------

let logEl: HTMLPreElement | null = null;
let nextLine = 0;
let streamFor = 0;
let statusTimer: number | undefined;

function renderRun() {
  const root = $('screen-run');
  const run = state.run;
  if (!run) {
    root.replaceChildren(
      h('div', { class: 'screen-head' }, h('h1', {}, 'Live run')),
      h('div', { class: 'card empty' }, 'No run yet. Start one from My tasks.'),
    );
    return;
  }
  const stop = h('button', { type: 'button', class: 'btn danger', onclick: () => void confirmStop() }, 'Stop');
  stop.hidden = run.state !== 'running';
  const stateKind = { running: 'info', done: 'ok', failed: 'bad', stopped: 'warn' }[run.state];
  const head = h(
    'div',
    { class: 'screen-head' },
    h(
      'div',
      {},
      h('h1', {}, `${run.mode === 'run' ? 'Run' : 'Resume'} ${run.taskId}`),
      h(
        'div',
        { class: 'row small muted' },
        badge(run.state, stateKind),
        `with ${run.runner}, started ${new Date(run.startedAt).toLocaleTimeString()}`,
      ),
    ),
    stop,
  );
  const facts = h(
    'div',
    { class: 'facts card', id: 'run-facts' },
    h('span', { class: 'muted small' }, 'Loading the task status…'),
  );
  if (!logEl || streamFor !== run.id) {
    logEl = h('pre', { class: 'log mono', 'aria-live': 'off', tabindex: '0' });
    nextLine = 0;
  }
  root.replaceChildren(head, facts, logEl);
  // Follows a running run; for a finished one it replays the log once.
  if (streamFor !== run.id) void followLog(run.id);
  void loadRunStatus();
  window.clearInterval(statusTimer);
  if (run.state === 'running') statusTimer = window.setInterval(() => void loadRunStatus(), 15_000);
}

async function loadRunStatus() {
  const box = document.getElementById('run-facts');
  if (!box) return;
  const fact = (label: string, value: string | number | null) =>
    h(
      'div',
      { class: 'fact' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value === null || value === '' ? '—' : String(value)),
    );
  try {
    const s = await api<RunStatus>('/api/runs/current/status');
    box.replaceChildren(
      fact('Task', s.name),
      fact('ClickUp status', s.status),
      fact('Current role', s.role === 'human' ? 'human (ready for review)' : s.role),
      fact('Round', s.round ?? (s.rounds || null)),
      fact('Last agent result', s.lastAgent ? `${s.lastAgent} ${s.lastResult ?? ''}` : null),
      fact('Last handoff entry', s.handoff),
    );
    if (s.lastSummary)
      box.append(
        h(
          'div',
          { class: 'fact' },
          h('div', { class: 'label' }, 'Last summary'),
          h('div', { class: 'value small' }, s.lastSummary),
        ),
      );
  } catch (e) {
    box.replaceChildren(h('span', { class: 'muted small' }, `Status not available: ${(e as Error).message}`));
  }
}

/** Reads the newline-delimited JSON log stream and appends lines until the run ends. */
async function followLog(runId: number) {
  streamFor = runId;
  try {
    const res = await fetch(`/api/runs/current/stream?from=${nextLine}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      cache: 'no-store',
    });
    if (!res.ok || !res.body) throw new Error(`log stream: HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      const atBottom = logEl ? logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40 : true;
      for (const line of lines) {
        if (!line) continue;
        const e = JSON.parse(line) as RunEvent;
        if (e.type === 'line' && e.index >= nextLine) {
          logEl?.append(`${e.text}\n`);
          nextLine = e.index + 1;
        } else if (e.type === 'state' && state.run && state.run.id === runId) {
          setRun({ ...state.run, state: e.state });
          window.clearInterval(statusTimer);
          if (state.tab === 'run') renderRun();
          loaded.delete('tasks'); // statuses changed: reload when the tab opens
        }
      }
      if (atBottom && logEl) logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (e) {
    logEl?.append(`\n[console] ${(e as Error).message}\n`);
  }
}

async function confirmStop() {
  const dialog = $('dialog') as HTMLDialogElement;
  const close = () => dialog.close();
  const stop = h('button', { type: 'button', class: 'btn danger' }, 'Stop the agent');
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try {
      await api<RunInfo>('/api/runs/stop', {});
      close();
    } catch (e) {
      dialog.firstElementChild?.append(errorBox(e));
    }
  });
  dialog.replaceChildren(
    h(
      'div',
      { class: 'dialog-body' },
      h('h2', { id: 'dialog-title' }, 'Stop this run?'),
      h(
        'p',
        {},
        'The agent and every process it started are stopped. Changes it made so far stay on the task branch; you can resume later.',
      ),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
        stop,
      ),
    ),
  );
  dialog.showModal();
}

// ---------- start ----------

async function start() {
  renderThemeToggle();
  try {
    const info = await api<ProjectInfo>('/api/project');
    state.project = info;
    state.runner = info.project?.defaultRunner ?? null;
    setRun(info.run);
    $('project-name').textContent = info.project?.name ?? info.cwd;
    $('project-meta').textContent = `kit v${info.kitVersion} · ${info.cwd}`;
  } catch (e) {
    $('main').replaceChildren(errorBox(e));
    return;
  }
  const fromHash = location.hash.slice(1) as Tab;
  showTab(['health', 'tasks', 'run'].includes(fromHash) ? fromHash : running() ? 'run' : 'health');
}
void start();
