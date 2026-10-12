import Link from 'next/link';
import type { ReactNode } from 'react';

export function PageHeader({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
        {intro && <p className="mt-1 text-sm leading-relaxed text-muted">{intro}</p>}
      </div>
      {children}
    </div>
  );
}

const CHIP = {
  neutral: 'bg-subtle text-ink-2',
  blue: 'bg-info-bg text-info-fg',
  green: 'bg-ok-bg text-ok-fg',
  amber: 'bg-warn-bg text-warn-fg',
  red: 'bg-bad-bg text-bad-fg',
};

export function Chip({
  children,
  tone = 'neutral',
  href,
  title,
}: {
  children: ReactNode;
  tone?: keyof typeof CHIP;
  href?: string;
  title?: string;
}) {
  const cls = `inline-flex items-center gap-1 rounded-sm px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${CHIP[tone]}`;
  return href ? (
    <Link href={href} className={`${cls} hover:ring-1 hover:ring-line-strong`} title={title}>
      {children}
    </Link>
  ) : (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function Card({ children, className = '', href }: { children: ReactNode; className?: string; href?: string }) {
  const cls = `block rounded-md border border-line bg-card p-5 ${className}`;
  return href ? (
    <Link href={href} className={`${cls} transition hover:border-line-strong`}>
      {children}
    </Link>
  ) : (
    <div className={cls}>{children}</div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{children}</h2>;
}

export function Lock() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-sm bg-bad-bg px-2 py-0.5 text-[11px] font-semibold text-bad-fg"
      title="Locked: cannot be changed from the dashboard"
    >
      🔒 Locked
    </span>
  );
}

export function Back({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm text-accent hover:underline">
      ← {children}
    </Link>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted">{children}</span>;
}

/** Plain text with `code` spans (agent purposes come from the Markdown agent files). */
export function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={i} className="rounded bg-subtle px-1 font-mono text-[0.85em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
