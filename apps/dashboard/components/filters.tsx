'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

interface Option {
  value: string;
  label: string;
}

/** Project / assignee filters, kept in the URL (?project=…&assignee=…) so a filtered board can be shared. */
export function Filters({ projects, assignees }: { projects: Option[]; assignees: Option[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className="flex flex-wrap gap-3">
      <Select
        label="Project"
        value={params.get('project') ?? ''}
        options={projects}
        onChange={(v) => set('project', v)}
      />
      <Select
        label="Assignee"
        value={params.get('assignee') ?? ''}
        options={assignees}
        onChange={(v) => set('assignee', v)}
      />
    </div>
  );
}

function Select(props: { label: string; value: string; options: Option[]; onChange: (value: string) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-full border border-line bg-card py-1.5 pr-2 pl-4 text-sm">
      <span className="text-muted">{props.label}</span>
      <select
        className="cursor-pointer rounded-full bg-transparent py-0.5 pr-1 font-medium outline-none"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">All</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
