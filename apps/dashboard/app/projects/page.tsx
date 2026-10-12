import { Card, Chip, PageHeader } from '@/components/ui';
import { LIBRARY_VERSION, TOOL_LABEL, getAgent, getMcp, libraryProjects } from '@/lib/library';

export const metadata = { title: 'Projects · Agent Pipelines' };

export default function ProjectsPage() {
  return (
    <>
      <PageHeader
        title="Projects"
        intro={
          <>
            Each project&apos;s profile: the roles in order, skills, MCP servers and the agent tools it generates files
            for. Latest team library: {LIBRARY_VERSION}.
          </>
        }
      />
      <div className="space-y-4">
        {libraryProjects.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium">{p.name}</h2>
                <p className="mt-0.5 text-sm text-muted">{p.type}</p>
              </div>
              <Chip tone={p.library === LIBRARY_VERSION ? 'green' : 'amber'} title="Pinned team library version">
                Library {p.library}
                {p.library === LIBRARY_VERSION ? '' : ' · update available'}
              </Chip>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-4">
              <Field label="Pipeline">
                <div className="flex flex-wrap items-center gap-1 text-sm">
                  <Chip href="/agents/orchestrator">Orchestrator</Chip>
                  <span className="text-muted">:</span>
                  {p.roles.map((r, i) => (
                    <span key={r} className="flex items-center gap-1">
                      {i > 0 && <span className="text-muted">→</span>}
                      <Chip tone="blue" href={`/agents/${r}`}>
                        {getAgent(r)?.title ?? r}
                      </Chip>
                    </span>
                  ))}
                </div>
              </Field>
              <Field label="Skills">
                <List items={p.skills} href={(s) => `/skills/${s}`} />
              </Field>
              <Field label="MCP servers">
                {p.mcp.length ? (
                  <List items={p.mcp} label={(m) => getMcp(m)?.name ?? m} href={() => '/mcp'} />
                ) : (
                  <span className="text-sm text-muted">None</span>
                )}
              </Field>
              <Field label="Agent tools">
                <List items={p.tools} label={(t) => TOOL_LABEL[t] ?? t} />
              </Field>
            </div>
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-1.5 text-xs text-muted">Quality gate (commands the roles may run in this project)</p>
              <div className="flex flex-wrap gap-1">
                {p.commands.map((c) => (
                  <code key={c} className="rounded bg-[#f1f3f4] px-1.5 py-0.5 font-mono text-xs">
                    {c}
                  </code>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs text-muted">{label}</p>
      {children}
    </div>
  );
}

function List({
  items,
  label = (x) => x,
  href,
}: {
  items: string[];
  label?: (item: string) => string;
  href?: (item: string) => string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <Chip key={i} href={href?.(i)}>
          {label(i)}
        </Chip>
      ))}
    </div>
  );
}
