/**
 * Readable live output of a headless agent. Antigravity (`agy -p --output-format stream-json`) and Claude Code
 * (`claude -p --output-format stream-json --verbose`) print one JSON event per line; their plain text mode prints
 * only the final answer, so there would be nothing to watch. OpenCode `run` and `codex exec` already print readable
 * progress and pass through unchanged.
 *
 * The event formats are not formally documented: anything that does not parse is printed as it is, so nothing is
 * lost when a tool changes them. Event shapes checked with agy 1.3.4 and Claude Code 2.1.
 */
import { parseAgentComment, type AgentComment } from '@tossana/agents-core';

export type OutputFormat = 'text' | 'agy-stream' | 'claude-stream';

export interface StreamRenderer {
  /** One raw output line in, the readable lines out (possibly none). */
  line(raw: string): string[];
  /** Whatever is still buffered when the process ends. */
  end(): string[];
  /** The agent's final answer (stream formats), or its whole output (text). */
  finalText(): string;
}

/** Keep at most this much text for finding the report (the end of the output is what matters). */
const MAX_TEXT = 200_000;
const MAX_OUTPUT_LINES = 3;
const MAX_LINE = 200;

const clip = (s: string, n = MAX_LINE) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The interesting argument of a tool call: the command, file or pattern, else short JSON. */
export function toolArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of [
    'CommandLine',
    'command',
    'file_path',
    'AbsolutePath',
    'TargetFile',
    'DirectoryPath',
    'path',
    'pattern',
    'Pattern',
    'Query',
    'query',
    'url',
    'description',
  ]) {
    if (typeof o[key] === 'string' && o[key]) return clip(String(o[key]).replace(/\s*\r?\n\s*/g, ' '));
  }
  return clip(JSON.stringify(o));
}

/** The first lines of a tool's output, indented. */
function outputLines(output: unknown): string[] {
  const text =
    typeof output === 'string'
      ? output
      : Array.isArray(output)
        ? output.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join('\n')
        : '';
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim());
  const shown = lines.slice(0, MAX_OUTPUT_LINES).map((l) => `    ${clip(l)}`);
  if (lines.length > MAX_OUTPUT_LINES) shown.push(`    … (${lines.length - MAX_OUTPUT_LINES} more lines)`);
  return shown;
}

/** Text that arrives in pieces: complete lines go out at once, the rest when the step ends. */
function textBuffer() {
  let buf = '';
  return {
    push(delta: string): string[] {
      buf += delta;
      const end = buf.lastIndexOf('\n');
      if (end < 0) return [];
      const out = buf.slice(0, end).split('\n');
      buf = buf.slice(end + 1);
      return out;
    },
    flush(): string[] {
      const out = buf ? [buf] : [];
      buf = '';
      return out;
    },
  };
}

function parseJson(raw: string): Record<string, unknown> | null {
  if (!raw.trimStart().startsWith('{')) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function textRenderer(): StreamRenderer {
  let all = '';
  return {
    line: (raw) => {
      all = (all + raw + '\n').slice(-MAX_TEXT);
      return [raw];
    },
    end: () => [],
    finalText: () => all,
  };
}

/** agy: `init`, `step_update` (user_input, agent_response with text_delta, tool ACTIVE/DONE), `result`. */
function agyRenderer(): StreamRenderer {
  const text = textBuffer();
  let final = '';
  let streamed = '';
  return {
    line(raw) {
      const ev = parseJson(raw);
      if (!ev) return raw.trim() ? [raw] : [];
      if (ev.event === 'init') return ['[agy] session started'];
      if (ev.event === 'result') {
        const r = (ev.result ?? {}) as Record<string, unknown>;
        if (typeof r.response === 'string') final = r.response;
        const secs = typeof r.duration_seconds === 'number' ? `, ${Math.round(r.duration_seconds)} s` : '';
        const error = typeof r.error === 'string' && r.error ? `: ${r.error}` : '';
        return [...text.flush(), `[agy] finished: ${String(r.status ?? '?')}${secs}${error}`];
      }
      if (ev.event !== 'step_update') return [];
      const s = (ev.step_update ?? {}) as Record<string, unknown>;
      if (s.step_type === 'agent_response') {
        const delta = typeof s.text_delta === 'string' ? s.text_delta : '';
        streamed = (streamed + delta).slice(-MAX_TEXT);
        const out = text.push(delta);
        return s.state === 'DONE' ? [...out, ...text.flush()] : out;
      }
      if (s.step_type === 'tool') {
        const info = (s.tool_info ?? {}) as Record<string, unknown>;
        const name = String(s.tool_name ?? info.name ?? 'tool');
        if (s.state === 'ACTIVE') return [...text.flush(), `→ ${name} ${toolArgs(info.parameters)}`.trimEnd()];
        if (s.state === 'DONE') return outputLines(info.output);
        if (typeof s.state === 'string' && s.state !== 'DONE') return [`  ${name}: ${s.state.toLowerCase()}`];
      }
      return [];
    },
    end: () => text.flush(),
    finalText: () => final || streamed,
  };
}

/** Claude Code: `system` init, `assistant` (text / tool_use), `user` (tool_result), `result`. */
function claudeRenderer(): StreamRenderer {
  let final = '';
  let streamed = '';
  return {
    line(raw) {
      const ev = parseJson(raw);
      if (!ev) return raw.trim() ? [raw] : [];
      if (ev.type === 'system') return ev.subtype === 'init' ? ['[claude] session started'] : [];
      if (ev.type === 'result') {
        if (typeof ev.result === 'string') final = ev.result;
        const secs = typeof ev.duration_ms === 'number' ? `, ${Math.round(ev.duration_ms / 1000)} s` : '';
        return [`[claude] finished: ${String(ev.subtype ?? '?')}${ev.is_error ? ' (error)' : ''}${secs}`];
      }
      const content = ((ev.message ?? {}) as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      const out: string[] = [];
      for (const part of content as Record<string, unknown>[]) {
        if (ev.type === 'assistant' && part.type === 'text' && typeof part.text === 'string') {
          streamed = (streamed + part.text + '\n').slice(-MAX_TEXT);
          out.push(...part.text.split(/\r?\n/));
        } else if (ev.type === 'assistant' && part.type === 'tool_use') {
          out.push(`→ ${String(part.name ?? 'tool')} ${toolArgs(part.input)}`.trimEnd());
        } else if (ev.type === 'user' && part.type === 'tool_result') {
          out.push(...(part.is_error ? ['    (error)'] : []), ...outputLines(part.content));
        }
      }
      return out;
    },
    end: () => [],
    finalText: () => final || streamed,
  };
}

export function streamRenderer(format: OutputFormat): StreamRenderer {
  if (format === 'agy-stream') return agyRenderer();
  if (format === 'claude-stream') return claudeRenderer();
  return textRenderer();
}

const REPORT_HEADER = (role: string) =>
  new RegExp(`\\[\\s*AGENT\\s*:\\s*${role.replace(/[-]/g, '\\-')}\\s*\\]\\s*\\[\\s*RESULT\\s*:`, 'gi');

/**
 * The role's last `[AGENT: <role>] [RESULT: …]` report in an agent's output, up to and including its `Next:` line,
 * or null. Returns the exact text (to post as the comment) and the parsed comment.
 */
export function extractReport(output: string, role: string): { text: string; comment: AgentComment } | null {
  const text = output.replace(/\r\n?/g, '\n');
  const starts = [...text.matchAll(REPORT_HEADER(role))].map((m) => m.index);
  for (const start of starts.reverse()) {
    const lines = text.slice(start).split('\n');
    const next = lines.findIndex((l) => /^\s*next\s*:/i.test(l));
    const block = (next >= 0 ? lines.slice(0, next + 1) : lines.filter((l) => !/^\s*```/.test(l))).join('\n').trim();
    const comment = parseAgentComment(block);
    if (comment && comment.agent === role) return { text: block, comment };
  }
  return null;
}
