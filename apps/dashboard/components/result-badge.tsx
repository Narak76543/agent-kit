import type { AgentResult } from '@tossana/agents-core';
import { resultTone, type Tone } from '@/lib/data';

const TONES: Record<Tone, string> = {
  green: 'bg-ok-bg text-ok-fg',
  amber: 'bg-warn-bg text-warn-fg',
  red: 'bg-bad-bg text-bad-fg',
  neutral: 'bg-subtle text-ink-2',
};

export function ResultBadge({ result }: { result: AgentResult }) {
  return (
    <span
      className={`inline-flex items-center rounded-sm px-2 py-0.5 text-[11px] font-semibold tracking-wide ${TONES[resultTone(result)]}`}
    >
      {result.replace('_', ' ')}
    </span>
  );
}
