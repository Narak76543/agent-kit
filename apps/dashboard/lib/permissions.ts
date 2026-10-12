/**
 * Turns an OpenCode agent `permission` block into plain-English lines for the dashboard.
 * OpenCode rules: the LAST matching rule wins; the kit always starts with "*": deny (default deny).
 * Windows-path duplicates of path rules (with backslashes) are hidden: they mean the same thing.
 */
import type { Permission } from './library';

export interface PermissionLine {
  text: string;
  /** Part of the locked rules (cannot be changed from the dashboard). */
  locked?: boolean;
  code?: string[];
}

export interface PermissionSummary {
  can: PermissionLine[];
  never: PermissionLine[];
}

const rulesOf = (value: string | Record<string, string> | undefined): [string, string][] =>
  value === undefined ? [] : typeof value === 'string' ? [['*', value]] : Object.entries(value);

const posix = (rules: [string, string][]) => rules.filter(([pattern]) => !pattern.includes('\\'));
const patterns = (rules: [string, string][], action: string) =>
  posix(rules)
    .filter(([p, a]) => a === action && p !== '*')
    .map(([p]) => p);

// Path rules -> readable names: drops the "any folder" prefix and the trailing "*" of folder rules.
function paths(list: string[]): string[] {
  const out = new Set<string>();
  for (const p of list) {
    const clean = p.replace(/^\*\//, '').replace(/^\*(?=agent\.config\.json$)/, '');
    out.add(clean.endsWith('/*') ? `${clean.slice(0, -1)}` : clean);
  }
  return [...out];
}

/** "pnpm lint*" → "pnpm lint …"; kit prefixes are merged ("tossana-agents" and "npx tossana-agents"). */
function commands(list: string[]): string[] {
  const out = new Set<string>();
  for (const p of list) {
    const cmd = p
      .replace(/^npx (?=tossana-agents)/, '')
      .replace(/^\*(?=tossana-agents)/, '')
      .replace(/ ?\*$/, ' …')
      .replace(/\*/g, '…')
      .trim();
    out.add(cmd);
  }
  return [...out];
}

const LOCKED_COMMAND = /push|merge|rebase|status|reset|branch -[dD]|--delete|clean|checkout|switch|amend|--force/;

export function describePermissions(permission: Permission): PermissionSummary {
  const can: PermissionLine[] = [];
  const never: PermissionLine[] = [];

  // Reading
  const read = rulesOf(permission.read);
  if (read.some(([p, a]) => p === '*' && a === 'allow')) {
    const denied = patterns(read, 'deny');
    can.push({
      text: denied.length ? 'Read every file in the project, except:' : 'Read every file in the project.',
      code: denied.length ? paths(denied).concat('(.env.example is allowed)') : undefined,
    });
  }
  if (patterns(read, 'deny').some((p) => p.includes('.env'))) {
    never.push({ text: 'Read .env files (tokens).', locked: true });
  }

  const search = ['glob', 'grep', 'lsp'].filter((k) => permission[k] === 'allow');
  if (search.length) can.push({ text: `Search the code (${search.join(', ')}).` });

  // Editing
  const edit = rulesOf(permission.edit);
  const editAll = edit.find(([p]) => p === '*')?.[1] === 'allow';
  const editAllowed = paths(patterns(edit, 'allow'));
  if (editAll) {
    can.push({ text: 'Edit any file, except:', code: paths(patterns(edit, 'deny')) });
    if (editAllowed.length) can.push({ text: 'But it may still write its comment drafts in:', code: editAllowed });
  } else if (editAllowed.length) {
    const tmpOnly = editAllowed.every((p) => p.startsWith('.agents/tmp'));
    can.push({
      text: tmpOnly ? 'Edit no project files. Only its comment drafts in:' : 'Edit only these files:',
      code: editAllowed,
    });
  } else {
    never.push({ text: 'Edit any file.' });
  }

  // Subagents
  const task = rulesOf(permission.task);
  const subagents = patterns(task, 'allow');
  if (subagents.length) can.push({ text: 'Start these agents:', code: subagents });

  // MCP tools (e.g. figma_get_design_context)
  const mcp = Object.entries(permission).filter(([k, v]) => k.includes('_') && v === 'allow');
  const servers = new Map<string, string[]>();
  for (const [key] of mcp) {
    const [server, ...rest] = key.split('_');
    servers.set(server!, [...(servers.get(server!) ?? []), rest.join('_')]);
  }
  for (const [server, tools] of servers) {
    can.push({ text: `Use ${server[0]!.toUpperCase()}${server.slice(1)} (read only):`, code: tools });
  }

  // Commands
  const bash = rulesOf(permission.bash);
  const allowed = commands(patterns(bash, 'allow'));
  if (allowed.length) can.push({ text: 'Run these commands:', code: allowed });
  else never.push({ text: 'Run any command.' });
  const denied = commands(patterns(bash, 'deny'));
  const doneRules = denied.filter((c) => /status …(done|complete|closed)/i.test(c));
  if (doneRules.length || denied.some((c) => c.startsWith('tossana-agents clickup status'))) {
    never.push({
      text: doneRules.length ? 'Set a ClickUp task to Done, Complete or Closed.' : 'Change ClickUp task statuses.',
      locked: doneRules.length > 0,
    });
  }
  const rest = denied.filter((c) => !c.includes('clickup status'));
  if (rest.some((c) => /api\.clickup\.com|CLICKUP_API_TOKEN|\.env/.test(c))) {
    never.push({
      text: 'Call the ClickUp API directly or use the token in a command (only through the kit).',
      locked: true,
    });
  }
  if (rest.some((c) => c.includes('git push')))
    never.push({ text: 'Run git push (nothing leaves this machine).', locked: true });
  const other = rest
    .filter((c) => !/api\.clickup\.com|CLICKUP_API_TOKEN|\.env|git push/.test(c))
    .map((c) => c.replace(/^…/, ''));
  if (other.length) {
    never.push({
      text: 'Run these, even when a broader rule would allow them:',
      code: other,
      locked: other.some((c) => LOCKED_COMMAND.test(c)),
    });
  }

  if (permission['*'] === 'deny') {
    never.push({ text: 'Anything not listed above (default deny, never asks for permission).', locked: true });
  }
  return { can, never };
}
