/**
 * The agent comment protocol: the single source of truth for the format agents post on
 * ClickUp tasks. The CLI writes it, the dashboard parses it.
 *
 *   [AGENT: reviewer] [RESULT: CHANGES_NEEDED] [ROUND: 2]
 *   Summary: <1-3 lines>
 *   Issues:
 *   - <file:line> - <problem>
 *   Next: <agent name | human>
 *
 * The parser also accepts the older one-line form used in EKMONG_MOBILE:
 *   Issues: a.ts:1 - x; b.ts:2 - y      (or "Issues: none")
 */

export const AGENTS = ['orchestrator', 'coder', 'reviewer', 'tester'] as const;
export type AgentName = (typeof AGENTS)[number];

export const RESULTS = ['STARTED', 'DONE_CODING', 'APPROVED', 'CHANGES_NEEDED', 'PASS', 'FAIL', 'NEEDS_HUMAN'] as const;
export type AgentResult = (typeof RESULTS)[number];

export interface AgentIssue {
  /** `file:line` (or just a file), when the issue names one. */
  location: string | null;
  text: string;
}

export interface AgentComment {
  agent: AgentName;
  result: AgentResult;
  /** `null` when the comment has no `[ROUND: n]` tag. */
  round: number | null;
  summary: string;
  issues: AgentIssue[];
  /** Lower-cased agent name or "human"; `null` when missing. */
  next: string | null;
}

export interface AgentCommentInput {
  agent: AgentName;
  result: AgentResult;
  round: number;
  summary: string;
  issues?: (AgentIssue | string)[];
  next: string;
}

export function formatAgentComment(data: AgentCommentInput): string {
  const issues = (data.issues ?? []).map((i) => (typeof i === 'string' ? { location: null, text: i } : i));
  const issueLines = issues.length
    ? issues.map((i) => `- ${i.location ? `${i.location} - ` : ''}${oneLine(i.text)}`)
    : ['- none'];
  return [
    `[AGENT: ${data.agent}] [RESULT: ${data.result}] [ROUND: ${data.round}]`,
    `Summary: ${data.summary.trim()}`,
    'Issues:',
    ...issueLines,
    `Next: ${data.next.trim()}`,
  ].join('\n');
}

const HEADER =
  /\[\s*AGENT\s*:\s*([A-Za-z]+)\s*\]\s*\[\s*RESULT\s*:\s*([A-Za-z_]+)\s*\](?:\s*\[\s*ROUND\s*:\s*(\d+)\s*\])?/i;
const FIELD = /^\s*(summary|issues|next)\s*:\s*(.*)$/i;
const BULLET = /^[-*•]\s+/;
const NONE = /^(none|n\/a|-|no issues\.?)$/i;

export function parseAgentComment(text: string): AgentComment | null {
  if (typeof text !== 'string') return null;
  const header = HEADER.exec(text);
  if (!header) return null;

  const agent = header[1]!.toLowerCase();
  const result = header[2]!.toUpperCase();
  if (!isAgent(agent) || !isResult(result)) return null;

  // Everything after the header, split into fields. A field runs until the next field label.
  const body = text.slice(header.index + header[0].length).replace(/\r\n?/g, '\n');
  const fields = { summary: [] as string[], issues: [] as string[], next: [] as string[] };
  let current: keyof typeof fields | null = null;
  for (const line of body.split('\n')) {
    const m = FIELD.exec(line);
    if (m) {
      current = m[1]!.toLowerCase() as keyof typeof fields;
      if (m[2]!.trim()) fields[current].push(m[2]!.trim());
    } else if (current && line.trim()) {
      fields[current].push(line.trim());
    }
  }

  const next = fields.next.join(' ').trim().toLowerCase();
  return {
    agent,
    result,
    round: header[3] === undefined ? null : Number(header[3]),
    summary: fields.summary.join('\n'),
    issues: parseIssues(fields.issues),
    next: next || null,
  };
}

function parseIssues(lines: string[]): AgentIssue[] {
  const items: string[] = [];
  for (const line of lines) {
    if (BULLET.test(line)) items.push(line.replace(BULLET, ''));
    else items.push(...line.split(';'));
  }
  return items
    .map((s) => s.trim())
    .filter((s) => s && !NONE.test(s))
    .map(parseIssue);
}

function parseIssue(item: string): AgentIssue {
  const sep = item.indexOf(' - ');
  if (sep <= 0) return { location: null, text: item };
  return { location: item.slice(0, sep).trim(), text: item.slice(sep + 3).trim() };
}

const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').trim();
const isAgent = (s: string): s is AgentName => (AGENTS as readonly string[]).includes(s);
const isResult = (s: string): s is AgentResult => (RESULTS as readonly string[]).includes(s);
