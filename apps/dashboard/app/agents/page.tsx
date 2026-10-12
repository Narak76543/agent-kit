import { Card, Chip, InlineCode, Lock, PageHeader } from '@/components/ui';
import { LIBRARY_VERSION, PRESET_LABEL, TOOL_LABEL, agents, lockedRules, projectsUsing } from '@/lib/library';

export const metadata = { title: 'Agents · Agent Pipelines' };

export default function AgentsPage() {
  return (
    <>
      <PageHeader
        title="Agents"
        intro={
          <>
            The standard roles in team library {LIBRARY_VERSION}. Each project fills in its own name, commands and
            skills (see Projects). The orchestrator runs the roles in order. Projects can choose roles, skills and MCP
            servers; the locked rules always apply.
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((a) => (
          <Card key={a.name} href={`/agents/${a.name}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-muted">
                  {a.order === 0 ? 'Runs the pipeline' : `Step ${a.order}`} · {a.mode}
                </p>
                <h2 className="mt-0.5 text-lg font-medium">{a.title}</h2>
              </div>
              <Chip tone={a.preset === 'read-only' ? 'green' : a.preset === 'edit-code' ? 'amber' : 'blue'}>
                {PRESET_LABEL[a.preset]}
              </Chip>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-[#3c4043]">
              <InlineCode text={a.purpose} />
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {a.skills.map((s) => (
                <Chip key={s} tone="blue">
                  {s}
                </Chip>
              ))}
              {a.mcp.map((m) => (
                <Chip key={m}>MCP: {m}</Chip>
              ))}
            </div>
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              Tools: {a.tools.map((t) => TOOL_LABEL[t]).join(', ')} · used by{' '}
              {a.order === 0 ? 'every project' : `${projectsUsing('roles', a.name).length} projects`}
            </p>
          </Card>
        ))}
      </div>

      <section className="mt-8 rounded-2xl border border-[#f4c7c3] bg-[#fffafa] p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">Locked rules for every role</h2>
          <Lock />
        </div>
        <ul className="mt-3 space-y-1.5 text-sm leading-relaxed">
          {lockedRules.map((r) => (
            <li key={r.id} className="flex gap-2">
              <span aria-hidden>•</span>
              {r.text}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
