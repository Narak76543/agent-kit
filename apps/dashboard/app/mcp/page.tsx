import { Card, Chip, PageHeader } from '@/components/ui';
import { agents, mcpServers, projectsUsing } from '@/lib/library';

export const metadata = { title: 'MCP catalog · Agent Pipelines' };

export default function McpPage() {
  return (
    <>
      <PageHeader
        title="MCP catalog"
        intro="Projects can only use MCP servers from this approved list. Adding a server needs an approver. Logins and tokens stay on each developer's machine."
      />
      <div className="space-y-4">
        {mcpServers.map((m) => {
          const projects = projectsUsing('mcp', m.id);
          const roles = agents.filter((a) => a.mcp.includes(m.id));
          return (
            <Card key={m.id} className={m.status === 'pending' ? 'border-dashed' : ''}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-medium">{m.name}</h2>
                  <p className="mt-0.5 font-mono text-xs break-all text-muted">{m.url}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Chip tone={m.status === 'approved' ? 'green' : 'amber'}>
                    {m.status === 'approved' ? 'Approved' : 'Waiting for approval'}
                  </Chip>
                  <Chip tone="blue">{m.access}</Chip>
                </div>
              </div>
              <dl className="mt-4 grid gap-4 text-sm md:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted">Connection</dt>
                  <dd className="mt-0.5">{m.transport}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Login</dt>
                  <dd className="mt-0.5 leading-relaxed">{m.auth}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Notes</dt>
                  <dd className="mt-0.5 leading-relaxed">{m.notes}</dd>
                </div>
              </dl>
              <div className="mt-4">
                <p className="text-xs text-muted">Allowed tools</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.tools.map((t) => (
                    <code key={t} className="rounded bg-[#f1f3f4] px-1.5 py-0.5 font-mono text-xs">
                      {t}
                    </code>
                  ))}
                </div>
              </div>
              <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
                Roles: {roles.length ? roles.map((r) => r.title).join(', ') : '–'} · Projects:{' '}
                {projects.length ? projects.map((p) => p.name).join(', ') : 'none yet'}
              </p>
            </Card>
          );
        })}
      </div>
    </>
  );
}
