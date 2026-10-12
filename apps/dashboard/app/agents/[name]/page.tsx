import { notFound } from 'next/navigation';
import { Back, Card, Chip, Empty, InlineCode, Label, Lock } from '@/components/ui';
import { PRESET_LABEL, TOOL_LABEL, agents, getAgent, projectsUsing } from '@/lib/library';
import { describePermissions, type PermissionLine } from '@/lib/permissions';

export const generateStaticParams = () => agents.map((a) => ({ name: a.name }));

export default async function AgentPage({ params }: PageProps<'/agents/[name]'>) {
  const { name } = await params;
  const agent = getAgent(name);
  if (!agent) notFound();
  const { can, never } = describePermissions(agent.permission);
  const used = agent.order === 0 ? null : projectsUsing('roles', agent.name);

  return (
    <div className="mx-auto max-w-4xl">
      <Back href="/agents">Agents</Back>

      <Card className="mt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted">
              {agent.order === 0 ? 'Coordinator' : `Step ${agent.order} of the pipeline`}
            </p>
            <h1 className="mt-0.5 text-2xl font-medium">{agent.title}</h1>
          </div>
          <Chip tone="blue">Preset: {PRESET_LABEL[agent.preset]}</Chip>
        </div>
        <p className="mt-3 text-sm leading-relaxed">
          <InlineCode text={agent.purpose} />
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-4">
          <Fact label="Skills" value={agent.skills.length ? agent.skills.join(', ') : '–'} />
          <Fact label="MCP servers" value={agent.mcp.length ? agent.mcp.join(', ') : '–'} />
          <Fact label="Generated for" value={agent.tools.map((t) => TOOL_LABEL[t]).join(', ')} />
          <Fact label="Max steps" value={String(agent.steps)} />
        </dl>
      </Card>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <Label>Can</Label>
          <Lines lines={can} tone="green" />
        </Card>
        <Card>
          <Label>Never</Label>
          <Lines lines={never} tone="red" />
        </Card>
      </div>

      <Card className="mt-4">
        <Label>Used by projects</Label>
        {used === null ? (
          <Empty>Every project (it runs the pipeline).</Empty>
        ) : used.length ? (
          <div className="flex flex-wrap gap-1.5">
            {used.map((p) => (
              <Chip key={p.id} href="/projects">
                {p.name}
              </Chip>
            ))}
          </div>
        ) : (
          <Empty>No project yet.</Empty>
        )}
      </Card>

      <details className="mt-4 rounded-2xl border border-line bg-card p-5">
        <summary className="cursor-pointer text-sm font-medium">Raw OpenCode permission rules</summary>
        <p className="mt-2 text-xs text-muted">
          The last matching rule wins. Rules with backslashes are the same paths in Windows form.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-[#f8f9fa] p-4 font-mono text-xs leading-relaxed">
          {JSON.stringify(agent.permission, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{value}</dd>
    </div>
  );
}

function Lines({ lines, tone }: { lines: PermissionLine[]; tone: 'green' | 'red' }) {
  return (
    <ul className="space-y-3">
      {lines.map((l, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
          <span
            aria-hidden
            className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${
              tone === 'green' ? 'bg-[#1e8e3e]' : 'bg-[#d93025]'
            }`}
          >
            {tone === 'green' ? '✓' : '×'}
          </span>
          <div className="min-w-0">
            <span>{l.text}</span> {l.locked && <Lock />}
            {l.code && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {l.code.map((c) => (
                  <code key={c} className="rounded bg-[#f1f3f4] px-1.5 py-0.5 font-mono text-xs break-all">
                    {c}
                  </code>
                ))}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
