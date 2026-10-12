import Link from 'next/link';
import { Suspense } from 'react';
import { Filters } from '@/components/filters';
import { ResultBadge } from '@/components/result-badge';
import { TOOL_LABEL } from '@/lib/library';
import { ROLES, ROLE_LABEL, getProjects, getTasks, since, type Role, type Task } from '@/lib/data';

export default async function BoardPage({ searchParams }: PageProps<'/'>) {
  const { project, assignee } = await searchParams;
  const all = getTasks();
  const tasks = all.filter((t) => (!project || t.project.id === project) && (!assignee || t.assignee === assignee));
  const byRole = (role: Role) => tasks.filter((t) => t.role === role).sort(byUrgency);
  const assignees = [...new Set(all.map((t) => t.assignee))].sort();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Pipeline board</h1>
          <p className="mt-1 text-sm text-muted">
            {tasks.length} tasks ·{' '}
            {tasks.filter((t) => t.role !== null && t.role !== 'todo' && t.role !== 'human').length} in progress ·{' '}
            {tasks.filter(needsHuman).length} need a human
          </p>
        </div>
        <Suspense>
          <Filters
            projects={getProjects().map((p) => ({ value: p.id, label: p.name }))}
            assignees={assignees.map((a) => ({ value: a, label: a }))}
          />
        </Suspense>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {ROLES.map((role) => {
          const column = byRole(role);
          return (
            <section key={role} className="flex min-w-0 flex-col gap-3 rounded-2xl bg-[#f1f3f4]/70 p-3">
              <h2 className="flex items-center justify-between px-1 pt-1 text-sm font-medium">
                {ROLE_LABEL[role]}
                <span className="rounded-full bg-card px-2 py-0.5 text-xs text-muted">{column.length}</span>
              </h2>
              {column.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
              {column.length === 0 && <p className="px-1 pb-2 text-sm text-muted">No tasks</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

const needsHuman = (t: Task) => t.role === 'human' && t.last?.result === 'NEEDS_HUMAN';
const newHumanComment = (t: Task) => t.timeline.at(-1)?.agent === null;
const byUrgency = (a: Task, b: Task) =>
  Number(needsHuman(b)) - Number(needsHuman(a)) || a.statusSince.localeCompare(b.statusSince);

function TaskCard({ task }: { task: Task }) {
  const urgent = needsHuman(task);
  return (
    <Link
      href={`/tasks/${task.id}`}
      className={`group block rounded-xl border bg-card p-4 shadow-[0_1px_2px_rgba(60,64,67,0.08)] transition hover:shadow-[0_2px_8px_rgba(60,64,67,0.16)] ${
        urgent ? 'border-[#f4c7c3] ring-1 ring-[#f4c7c3]' : 'border-line'
      }`}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate">{task.project.name}</span>
        <span className="shrink-0 tabular-nums" title="Time in this status">
          {since(task.statusSince)}
        </span>
      </div>
      <p className="mt-1.5 text-[15px] leading-snug font-medium group-hover:text-accent">{task.name}</p>

      {task.last ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted capitalize">{task.last.agent}</span>
          <ResultBadge result={task.last.result} />
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">Not started</p>
      )}

      {newHumanComment(task) && (
        <p className="mt-2 rounded-md bg-[#e8f0fe] px-2 py-1 text-xs text-[#174ea6]">New comment from a human</p>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="grid size-5 place-items-center rounded-full bg-[#e8eaed] text-[10px] font-semibold text-[#3c4043]">
            {task.assignee[0]}
          </span>
          {task.assignee}
        </span>
        <span className="flex items-center gap-2">
          {task.tool && <span className="rounded bg-[#f1f3f4] px-1.5 py-0.5 text-[11px]">{TOOL_LABEL[task.tool]}</span>}
          {task.round !== null && <span className="tabular-nums">Round {task.round}</span>}
        </span>
      </div>
    </Link>
  );
}
