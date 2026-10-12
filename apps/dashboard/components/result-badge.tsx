import type { AgentResult } from '@tossana/agents-core';
import { resultTone, type Tone } from '@/lib/data';

const TONES: Record<Tone, string> = {
  green: 'bg-[#e6f4ea] text-[#137333]',
  amber: 'bg-[#fef7e0] text-[#a05a00]',
  red: 'bg-[#fce8e6] text-[#c5221f]',
  neutral: 'bg-[#f1f3f4] text-[#3c4043]',
};

export function ResultBadge({ result }: { result: AgentResult }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ${TONES[resultTone(result)]}`}
    >
      {result.replace('_', ' ')}
    </span>
  );
}
