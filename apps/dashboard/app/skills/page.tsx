import { Card, Chip, PageHeader } from '@/components/ui';
import { SCOPE_LABEL, agents, projectsUsing, skills, type Skill } from '@/lib/library';

export const metadata = { title: 'Skills · Agent Pipelines' };

const SCOPE_TONE: Record<Skill['scope'], 'blue' | 'green' | 'neutral'> = {
  team: 'blue',
  project: 'green',
  user: 'neutral',
};

export default function SkillsPage() {
  return (
    <>
      <PageHeader
        title="Skills"
        intro="Instructions the roles follow. Three scopes: team (library), project (.agents/skills/ in the repo) and user (on each developer's machine). On a name clash the project skill wins, then user, then team."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {skills.map((s) => {
          const roles = agents.filter((a) => a.skills.includes(s.name));
          const projects = projectsUsing('skills', s.name);
          return (
            <Card key={s.name} href={`/skills/${s.name}`}>
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-mono text-[15px] font-medium">{s.name}</h2>
                <Chip tone={SCOPE_TONE[s.scope]}>{SCOPE_LABEL[s.scope]}</Chip>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.description}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {s.types.map((t) => (
                  <Chip key={t}>{t}</Chip>
                ))}
              </div>
              <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
                Roles: {roles.length ? roles.map((r) => r.title).join(', ') : '–'} · {projects.length} project
                {projects.length === 1 ? '' : 's'}
              </p>
            </Card>
          );
        })}
      </div>
    </>
  );
}
