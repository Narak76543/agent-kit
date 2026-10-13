/**
 * Local Console page (browser code, bundled by esbuild into dist/console.html). No framework: four screens.
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
  /** "Rei – Mobile · Codex", or the tool alone. */
  label: string;
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
  /** The agent chosen for the last run in this project (this machine). */
  lastAgent: string | null;
}
type Scope = 'team' | 'personal';
interface Profile {
  name: string;
  initials?: string;
  color?: string;
  tool: string;
  skills: string[];
  mcp: string[];
}
interface AgentRow {
  slug: string;
  scope: Scope;
  error: string | null;
  profile: Profile | null;
  label: string | null;
  initials: string | null;
  skills: { name: string; scope: string | null }[];
}
interface ToolInfo {
  tool: string;
  label: string;
  installed: boolean | null;
  version: string | null;
  setUp: boolean;
  headless: boolean;
}
interface AgentsInfo {
  agents: AgentRow[];
  tools: ToolInfo[];
  runners: { runner: string; label: string; installed: boolean | null }[];
  skills: { name: string; scope: string; description: string }[];
  mcp: { name: string; setUp: boolean }[];
  colors: string[];
  personalDir: string;
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

type Tab = 'health' | 'tasks' | 'agents' | 'run';
const TABS: Tab[] = ['health', 'tasks', 'agents', 'run'];
const state: { project: ProjectInfo | null; run: RunInfo | null; tab: Tab } = {
  project: null,
  run: null,
  tab: 'health',
};
const loaded = new Set<Tab>();

function showTab(tab: Tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const t of TABS) $(`screen-${t}`).hidden = t !== tab;
  if (!loaded.has(tab)) {
    loaded.add(tab);
    if (tab === 'health') void loadHealth();
    if (tab === 'tasks') void loadTasks();
    if (tab === 'agents') void loadAgents();
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
  const head = h(
    'div',
    { class: 'screen-head' },
    h(
      'div',
      {},
      h('h1', {}, 'My tasks'),
      h('p', { class: 'muted small' }, p ? `Assigned to you in list ${p.listId}.` : ''),
    ),
    h('div', { class: 'row' }, refresh),
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

/** Runners a run can use here: set up in this project and not known to be missing on this machine. */
const usableRunners = (info: AgentsInfo) => info.runners.filter((r) => r.installed !== false);

/**
 * Run/Resume: pick the agent (remembered per project) and the tool. When the agent's tool cannot run here, an
 * installed tool is offered instead (the agent's skills are kept). Then the dry run; Start is the confirmation.
 */
async function openPreview(task: Task, mode: 'run' | 'resume') {
  const dialog = $('dialog') as HTMLDialogElement;
  const body = h('div', { class: 'dialog-body' });
  const verb = mode === 'run' ? 'Run' : 'Resume';
  const title = h('h2', { id: 'dialog-title' }, `${verb} ${task.customId ?? task.id}`);
  const close = () => dialog.close();
  body.replaceChildren(title, h('p', { class: 'muted' }, 'Loading agents…'));
  dialog.replaceChildren(body);
  dialog.showModal();

  let info: AgentsInfo;
  try {
    info = await api<AgentsInfo>('/api/agents');
  } catch (e) {
    body.replaceChildren(title, errorBox(e), closeRow(close));
    return;
  }
  const usable = usableRunners(info);
  const agents = info.agents.filter((a) => a.profile);
  const agentSelect = h('select', { id: 'pick-agent' });
  agentSelect.append(h('option', { value: '' }, 'Project default (no agent profile)'));
  for (const a of agents) agentSelect.append(h('option', { value: a.slug }, `${a.label} (${a.scope})`));
  const last = state.project?.lastAgent;
  if (last && agents.some((a) => a.slug === last)) agentSelect.value = last;
  const toolSelect = h('select', { id: 'pick-tool' });
  for (const r of usable) toolSelect.append(h('option', { value: r.runner }, r.label));
  const toolNote = h('div', { class: 'notice', hidden: true });
  const previewBox = h('div', { class: 'stack' });

  /** The agent's tool when it can run here; otherwise the first usable tool, with a note. */
  const pickTool = () => {
    const agent = agents.find((a) => a.slug === agentSelect.value)?.profile;
    const def = state.project?.project?.defaultRunner ?? '';
    const want = agent?.tool ?? def;
    const ok = usable.some((r) => r.runner === want);
    toolSelect.value = ok ? want : (usable[0]?.runner ?? '');
    toolNote.hidden = ok || !agent;
    if (agent && !ok) {
      const t = info.tools.find((x) => x.tool === agent.tool);
      const why = !t?.setUp ? 'is not set up in this project' : 'is not installed on this machine';
      toolNote.textContent = `${t?.label ?? agent.tool} ${why}. Run with ${
        usable.find((r) => r.runner === toolSelect.value)?.label ?? 'another tool'
      } instead; ${agent.name}'s skills are kept.`;
    }
  };

  let seq = 0;
  const refresh = async () => {
    const mine = ++seq;
    previewBox.replaceChildren(h('p', { class: 'muted' }, 'Preparing the dry run…'));
    if (!toolSelect.value) {
      previewBox.replaceChildren(
        h('div', { class: 'notice bad' }, 'No tool can run here. Install one and set it up with init.'),
      );
      return;
    }
    try {
      const preview = await api<Preview>('/api/preview', {
        taskId: task.id,
        mode,
        runner: toolSelect.value,
        ...(agentSelect.value ? { agent: agentSelect.value } : {}),
      });
      if (mine === seq) renderPreview(preview);
    } catch (e) {
      if (mine === seq) previewBox.replaceChildren(errorBox(e));
    }
  };

  const renderPreview = (preview: Preview) => {
    const wip = preview.needsWipCommit ? h('input', { type: 'checkbox', id: 'confirm-wip' }) : null;
    const start = h('button', { type: 'button', class: 'btn primary' }, `${verb} run`);
    const problem = h('div', { class: 'notice bad', hidden: true, role: 'alert' });
    start.disabled = !!preview.busy || !!wip;
    wip?.addEventListener('change', () => (start.disabled = !!preview.busy || !wip.checked));
    start.addEventListener('click', async () => {
      start.disabled = true;
      try {
        const run = await api<RunInfo>('/api/runs', {
          previewId: preview.previewId,
          confirmWip: wip?.checked ?? false,
        });
        if (state.project) state.project.lastAgent = agentSelect.value || null;
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
    previewBox.replaceChildren(...parts.filter((x): x is Node | string => !!x));
  };

  agentSelect.addEventListener('change', () => {
    pickTool();
    void refresh();
  });
  toolSelect.addEventListener('change', () => {
    toolNote.hidden = true;
    void refresh();
  });
  pickTool();
  body.replaceChildren(
    title,
    h(
      'div',
      { class: 'form-grid' },
      h('label', { for: 'pick-agent' }, 'Agent'),
      agentSelect,
      h('label', { for: 'pick-tool' }, 'Tool'),
      toolSelect,
    ),
    toolNote,
    agents.length
      ? ''
      : h('p', { class: 'small muted' }, 'Tip: create named agents (tool + skills) on the Agents tab.'),
    previewBox,
  );
  void refresh();
}

const closeRow = (close: () => void) =>
  h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onclick: close }, 'Close'));

// ---------- Agents ----------

/** Same rule as the CLI (core profileSlug): "Rei – Mobile" → "rei-mobile". */
const slugOf = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

const avatar = (initials: string, color?: string) =>
  h('span', { class: `avatar av-${color ?? 'green'}`, 'aria-hidden': 'true' }, initials);

function toolBadges(t: ToolInfo | undefined): Node[] {
  if (!t) return [];
  return [
    t.installed === null
      ? badge('IDE: start it yourself')
      : t.installed
        ? badge(`installed${t.version ? ` ${t.version}` : ''}`, 'ok')
        : badge('not installed here', 'bad'),
    t.setUp ? badge('set up in this project', 'ok') : badge('not set up in this project', 'warn'),
  ];
}

async function loadAgents() {
  const root = $('screen-agents');
  const add = h('button', { type: 'button', class: 'btn primary' }, 'New agent');
  const head = h(
    'div',
    { class: 'screen-head' },
    h(
      'div',
      {},
      h('h1', {}, 'Agents'),
      h(
        'p',
        { class: 'muted small' },
        'A named agent = a tool + skills + MCP servers. It runs the project pipeline; its skills go to the coder and reviewer. Role permissions and locked rules never change.',
      ),
    ),
    add,
  );
  root.replaceChildren(head, h('p', { class: 'muted' }, 'Loading agents…'));
  let info: AgentsInfo;
  try {
    info = await api<AgentsInfo>('/api/agents');
  } catch (e) {
    root.replaceChildren(head, errorBox(e));
    return;
  }
  add.addEventListener('click', () => openAgentForm(info, null));
  if (!info.agents.length) {
    root.replaceChildren(
      head,
      h(
        'div',
        { class: 'card empty' },
        'No agents yet. Create one, e.g. "Rei – Mobile" with Codex and your mobile skills.',
      ),
    );
    return;
  }
  const cards = info.agents.map((a) => {
    if (!a.profile) {
      return h(
        'div',
        { class: 'card bad' },
        h('h3', {}, `${a.slug} (${a.scope})`),
        h('div', { class: 'small', style: undefined }, a.error ?? 'invalid'),
      );
    }
    const p = a.profile;
    const tool = info.tools.find((t) => t.tool === p.tool);
    return h(
      'div',
      { class: 'card agent' },
      h(
        'div',
        { class: 'agent-head' },
        avatar(a.initials ?? '?', p.color),
        h(
          'div',
          { class: 'agent-title' },
          h('h3', {}, p.name),
          h(
            'div',
            { class: 'muted small' },
            `${tool?.label ?? p.tool} · ${a.scope === 'team' ? 'Team' : 'Personal'} · ${a.slug}`,
          ),
        ),
      ),
      h('div', { class: 'row' }, ...toolBadges(tool)),
      h(
        'div',
        { class: 'row small' },
        h('span', { class: 'muted' }, 'Skills:'),
        ...(a.skills.length
          ? a.skills.map((s) =>
              badge(s.scope ? `${s.name} · ${s.scope}` : `${s.name} · missing`, s.scope ? 'info' : 'bad'),
            )
          : [h('span', { class: 'muted' }, 'none (project skill only)')]),
      ),
      p.mcp.length
        ? h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'MCP:'), ...p.mcp.map((m) => badge(m)))
        : null,
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => openAgentForm(info, a) }, 'Edit'),
        h('button', { type: 'button', class: 'btn danger', onclick: () => confirmDeleteAgent(a) }, 'Delete'),
      ),
    );
  });
  root.replaceChildren(head, h('div', { class: 'grid' }, ...cards));
}

/** New / edit agent: tool → name → skills → MCP, then a confirmation that shows the file it writes. */
function openAgentForm(info: AgentsInfo, existing: AgentRow | null) {
  const dialog = $('dialog') as HTMLDialogElement;
  const close = () => dialog.close();
  const p = existing?.profile;
  const body = h('div', { class: 'dialog-body' });
  const title = h('h2', { id: 'dialog-title' }, existing ? `Edit ${p?.name}` : 'New agent');

  // 1. tool
  const toolChoices = info.tools.map((t) =>
    h(
      'label',
      { class: 'choice' },
      h('input', {
        type: 'radio',
        name: 'tool',
        value: t.tool,
        checked: (p?.tool ?? info.tools.find((x) => x.setUp)?.tool) === t.tool,
      }),
      h('span', { class: 'choice-text' }, h('b', {}, t.label), h('span', { class: 'row' }, ...toolBadges(t))),
    ),
  );
  // 2. name, id, badge, scope
  const name = h('input', {
    type: 'text',
    id: 'agent-name',
    maxlength: '60',
    placeholder: 'e.g. Rei – Mobile',
    value: p?.name ?? '',
  });
  const slug = h('input', {
    type: 'text',
    id: 'agent-id',
    maxlength: '40',
    value: existing?.slug ?? '',
    disabled: !!existing,
  });
  let slugEdited = !!existing;
  slug.addEventListener('input', () => (slugEdited = true));
  name.addEventListener('input', () => {
    if (!slugEdited) slug.value = slugOf(name.value);
  });
  const initials = h('input', {
    type: 'text',
    id: 'agent-initials',
    maxlength: '3',
    placeholder: 'auto',
    value: p?.initials ?? '',
  });
  const color = h('select', { id: 'agent-color' });
  for (const c of info.colors) color.append(h('option', { value: c, selected: c === (p?.color ?? 'green') }, c));
  const scopeTeam = h('input', {
    type: 'radio',
    name: 'scope',
    value: 'team',
    checked: (existing?.scope ?? 'team') === 'team',
    disabled: !!existing,
  });
  const scopePersonal = h('input', {
    type: 'radio',
    name: 'scope',
    value: 'personal',
    checked: existing?.scope === 'personal',
    disabled: !!existing,
  });
  // 3. skills
  const chosen = new Set(p?.skills ?? []);
  const skillList = h('div', { class: 'stack skill-list' });
  const renderSkills = () => {
    const groups: [string, string][] = [
      ['project', 'Project skills (.agents/skills)'],
      ['user', 'Your skills (this machine)'],
      ['team', 'Team skills (bundled with the kit)'],
    ];
    const missing = [...chosen].filter((n) => !info.skills.some((s) => s.name === n));
    skillList.replaceChildren(
      ...groups.flatMap(([scope, label]) => {
        const items = info.skills.filter((s) => s.scope === scope);
        if (!items.length) return [];
        return [
          h('div', { class: 'small muted' }, label),
          ...items.map((s) => {
            const box = h('input', { type: 'checkbox', checked: chosen.has(s.name) });
            box.addEventListener('change', () => (box.checked ? chosen.add(s.name) : chosen.delete(s.name)));
            return h(
              'label',
              { class: 'confirm' },
              box,
              h('span', {}, h('b', {}, s.name), s.description ? ` — ${s.description}` : ''),
            );
          }),
        ];
      }),
      ...(missing.length
        ? [h('div', { class: 'notice' }, `Not available on this machine: ${missing.join(', ')}`)]
        : []),
    );
  };
  renderSkills();
  const newSkillName = h('input', { type: 'text', placeholder: 'skill-name', maxlength: '40' });
  const newSkillDesc = h('input', { type: 'text', placeholder: 'One line: what it is for', maxlength: '200' });
  const newSkillArea = h('div', { class: 'stack' });
  const newSkillBtn = h('button', { type: 'button', class: 'btn' }, 'Create project skill…');
  newSkillBtn.addEventListener('click', () => {
    const n = newSkillName.value.trim();
    const file = `.agents/skills/${n}/SKILL.md`;
    const yes = h('button', { type: 'button', class: 'btn primary' }, 'Create');
    const no = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    no.addEventListener('click', () => newSkillArea.replaceChildren());
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        await api('/api/skills', { name: n, description: newSkillDesc.value, confirm: true });
        info.skills.push({ name: n, scope: 'project', description: newSkillDesc.value.trim() });
        chosen.add(n);
        renderSkills();
        newSkillName.value = '';
        newSkillDesc.value = '';
        newSkillArea.replaceChildren(
          h('div', { class: 'notice' }, `Created ${file} from the template. Fill it in and commit it.`),
        );
      } catch (e) {
        newSkillArea.replaceChildren(errorBox(e));
      }
    });
    newSkillArea.replaceChildren(
      h('div', { class: 'small' }, `This writes ${file} (a template to fill in).`),
      h('div', { class: 'row' }, no, yes),
    );
  });
  // 4. MCP
  const mcpBoxes = info.mcp.map((m) => {
    const box = h('input', { type: 'checkbox', value: m.name, checked: (p?.mcp ?? []).includes(m.name) });
    return h(
      'label',
      { class: 'confirm' },
      box,
      h(
        'span',
        {},
        h('b', {}, m.name),
        m.setUp ? ' — set up in this project' : ` — not set up here yet (tossana-agents init --${m.name})`,
      ),
    );
  });

  const problem = h('div', { class: 'notice bad', hidden: true, role: 'alert' });
  const next = h('button', { type: 'button', class: 'btn primary' }, existing ? 'Review changes' : 'Review');
  const form = h(
    'div',
    { class: 'stack' },
    h('h3', {}, '1. Tool'),
    h('div', { class: 'stack' }, ...toolChoices),
    h('h3', {}, '2. Name'),
    h(
      'div',
      { class: 'form-grid' },
      h('label', { for: 'agent-name' }, 'Name'),
      name,
      h('label', { for: 'agent-id' }, 'Id (file name)'),
      slug,
      h('label', { for: 'agent-initials' }, 'Initials'),
      initials,
      h('label', { for: 'agent-color' }, 'Color'),
      color,
    ),
    h(
      'div',
      { class: 'row small' },
      h('label', { class: 'confirm' }, scopeTeam, 'Team agent: .agents/profiles/ in this project (commit it to share)'),
      h('label', { class: 'confirm' }, scopePersonal, `Personal: ${info.personalDir} (only this machine)`),
    ),
    h('h3', {}, '3. Skills'),
    h('p', { class: 'small muted' }, 'Added for the coder and reviewer, on top of the project skill.'),
    skillList,
    h('div', { class: 'row' }, newSkillName, newSkillDesc, newSkillBtn),
    newSkillArea,
    h('h3', {}, '4. MCP servers (approved catalog)'),
    ...mcpBoxes,
    problem,
    h(
      'div',
      { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
      next,
    ),
  );

  next.addEventListener('click', () => {
    const tool = (body.querySelector('input[name="tool"]:checked') as HTMLInputElement | null)?.value;
    const scope: Scope = scopePersonal.checked ? 'personal' : 'team';
    const profile: Profile = {
      name: name.value.trim(),
      ...(initials.value.trim() ? { initials: initials.value.trim() } : {}),
      color: color.value,
      tool: tool ?? '',
      skills: [...chosen],
      mcp: mcpBoxes
        .map((l) => l.querySelector('input')!)
        .filter((b) => b.checked)
        .map((b) => b.value),
    };
    const id = slug.value.trim();
    const missing = !profile.name ? 'a name' : !tool ? 'a tool' : !id ? 'an id (the name has no Latin letters)' : '';
    if (missing) {
      problem.hidden = false;
      problem.textContent = `Choose ${missing}.`;
      return;
    }
    const file = scope === 'team' ? `.agents/profiles/${id}.json` : `${info.personalDir}/${id}.json`;
    const save = h('button', { type: 'button', class: 'btn primary' }, 'Save');
    const back = h('button', { type: 'button', class: 'btn' }, 'Back');
    const saveProblem = h('div', { class: 'notice bad', hidden: true, role: 'alert' });
    back.addEventListener('click', () => body.replaceChildren(title, form));
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api('/api/agents', { scope, slug: id, profile, replace: !!existing, confirm: true });
        close();
        loaded.delete('agents');
        await loadAgents();
      } catch (e) {
        save.disabled = false;
        saveProblem.hidden = false;
        saveProblem.textContent = (e as Error).message;
      }
    });
    body.replaceChildren(
      title,
      h('p', {}, `This ${existing ? 'updates' : 'writes'} ${file}:`),
      h('pre', { class: 'preview mono' }, JSON.stringify({ version: 1, ...profile }, null, 2)),
      scope === 'team'
        ? h(
            'div',
            { class: 'notice' },
            'Team agent: commit this file so your team gets it (uncommitted files are picked up by a resume).',
          )
        : '',
      saveProblem,
      h('div', { class: 'dialog-actions' }, back, save),
    );
  });

  body.replaceChildren(title, form);
  dialog.replaceChildren(body);
  dialog.showModal();
}

function confirmDeleteAgent(a: AgentRow) {
  const dialog = $('dialog') as HTMLDialogElement;
  const close = () => dialog.close();
  const del = h('button', { type: 'button', class: 'btn danger' }, 'Delete');
  const problem = h('div', { class: 'notice bad', hidden: true, role: 'alert' });
  del.addEventListener('click', async () => {
    del.disabled = true;
    try {
      await api('/api/agents/delete', { scope: a.scope, slug: a.slug, confirm: true });
      close();
      await loadAgents();
    } catch (e) {
      problem.hidden = false;
      problem.textContent = (e as Error).message;
    }
  });
  dialog.replaceChildren(
    h(
      'div',
      { class: 'dialog-body' },
      h('h2', { id: 'dialog-title' }, `Delete ${a.profile?.name ?? a.slug}?`),
      h(
        'p',
        {},
        a.scope === 'team'
          ? `This deletes .agents/profiles/${a.slug}.json in this project (commit the deletion to remove it for your team).`
          : `This deletes ${a.slug}.json from your personal agents on this machine.`,
      ),
      problem,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'),
        del,
      ),
    ),
  );
  dialog.showModal();
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
        `${run.label}, started ${new Date(run.startedAt).toLocaleTimeString()}`,
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
    setRun(info.run);
    $('project-name').textContent = info.project?.name ?? info.cwd;
    $('project-meta').textContent = `kit v${info.kitVersion} · ${info.cwd}`;
  } catch (e) {
    $('main').replaceChildren(errorBox(e));
    return;
  }
  const fromHash = location.hash.slice(1) as Tab;
  showTab(TABS.includes(fromHash) ? fromHash : running() ? 'run' : 'health');
}
void start();
