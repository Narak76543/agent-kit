import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ResultBadge } from '@/components/result-badge';
import { ROLE_LABEL, getTask, since, type TimelineEntry } from '@/lib/data';

export default async function TaskPage({ params }: PageProps<'/tasks/[id]'>) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/" className="text-sm text-accent hover:underline">
        ← Pipeline board
      </Link>

      <header className="mt-4 rounded-2xl border border-line bg-card p-5 sm:p-6">
        <p className="text-sm text-muted">{task.project.name}</p>
        <h1 className="mt-1 text-xl leading-snug font-medium sm:text-2xl">{task.name}</h1>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <Fact label="Status" value={task.role ? ROLE_LABEL[task.role] : task.status} />
          <Fact label="In status for" value={since(task.statusSince)} />
          <Fact label="Assignee" value={task.assignee} />
          <Fact label="Round" value={task.round === null ? '–' : String(task.round)} />
        </dl>
        <a
          href={task.url}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-flex items-center gap-1 rounded-full border border-line px-4 py-1.5 text-sm font-medium text-accent hover:bg-[#f1f3f4]"
        >
          Open in ClickUp ↗
        </a>
      </header>

      <h2 className="mt-8 mb-4 text-sm font-medium text-muted">Timeline</h2>
      {task.timeline.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
          No agent activity yet.
        </p>
      ) : (
        <ol className="relative space-y-4 border-l border-line pl-6 sm:pl-8">
          {task.timeline.map((entry, i) => (
            <Entry key={i} entry={entry} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

const time = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

function Entry({ entry }: { entry: TimelineEntry }) {
  const a = entry.agent;
  return (
    <li className="relative">
      <span
        className={`absolute top-5 -left-[29px] size-2.5 rounded-full ring-4 ring-page sm:-left-[37px] ${a ? 'bg-[#9aa0a6]' : 'bg-accent'}`}
      />
      <article className="rounded-xl border border-line bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {a ? (
            <>
              <span className="font-medium capitalize">{a.agent}</span>
              <ResultBadge result={a.result} />
              {a.round !== null && <span className="text-xs text-muted">Round {a.round}</span>}
            </>
          ) : (
            <span className="font-medium">{entry.author} (human)</span>
          )}
          <span className="ml-auto text-xs text-muted tabular-nums">{time(entry.date)}</span>
        </div>
        {a ? (
          <>
            <p className="mt-2 text-sm leading-relaxed">{a.summary}</p>
            {a.issues.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {a.issues.map((issue, i) => (
                  <li key={i} className="rounded-lg bg-[#f8f9fa] px-3 py-2 text-sm leading-snug">
                    {issue.location && (
                      <code className="mr-1.5 font-mono text-xs break-all text-[#3c4043]">{issue.location}</code>
                    )}
                    {issue.text}
                  </li>
                ))}
              </ul>
            )}
            {a.next && <p className="mt-3 text-xs text-muted">Next: {a.next}</p>}
          </>
        ) : (
          <p className="mt-2 text-sm leading-relaxed whitespace-pre-line">{entry.text}</p>
        )}
      </article>
    </li>
  );
}
