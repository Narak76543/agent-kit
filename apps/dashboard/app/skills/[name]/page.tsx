import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Back, Card, Chip } from '@/components/ui';
import { SCOPE_LABEL, getSkill, projectsUsing, skills } from '@/lib/library';

export const generateStaticParams = () => skills.map((s) => ({ name: s.name }));

const WHERE = {
  team: 'Team library (bundled with the kit until the library repo exists)',
  project: '.agents/skills/<name>/SKILL.md in the project repo',
  user: '~/.agents/skills/<name>/ on the developer machine (never uploaded)',
};

export default async function SkillPage({ params }: PageProps<'/skills/[name]'>) {
  const { name } = await params;
  const skill = getSkill(name);
  if (!skill) notFound();
  const projects = projectsUsing('skills', skill.name);

  return (
    <div className="mx-auto max-w-4xl">
      <Back href="/skills">Skills</Back>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <h1 className="font-mono text-2xl font-medium">{skill.name}</h1>
        <Chip tone="blue">{SCOPE_LABEL[skill.scope]}</Chip>
      </div>
      <p className="mt-1 text-sm text-muted">{skill.description}</p>
      <p className="mt-1 text-xs text-muted">Where: {WHERE[skill.scope].replace('<name>', skill.name)}</p>
      {projects.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {projects.map((p) => (
            <Chip key={p.id} href="/projects">
              {p.name}
            </Chip>
          ))}
        </div>
      )}

      <Card className="mt-6">
        {/* react-markdown renders no raw HTML: safe for text that editors will change later. */}
        <article className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.body}</ReactMarkdown>
        </article>
      </Card>
    </div>
  );
}
