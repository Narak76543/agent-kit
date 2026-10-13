/**
 * Dashboard data. v1 reads fixtures/tasks.json; later this file will read ClickUp (server-side, cached).
 * Agent comments are parsed with core's parseAgentComment, the same parser the CLI uses.
 */
import { parseAgentComment, type AgentComment, type AgentResult } from '@tossana/agents-core';
import fixtures from '../fixtures/tasks.json';
import { TOOL_LABEL, libraryProjects } from './library';

export const ROLES = ['todo', 'coding', 'review', 'testing', 'human'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  todo: 'To Do',
  coding: 'Coding',
  review: 'In Review',
  testing: 'Testing',
  human: 'Ready for Review',
};

export interface Project {
  id: string;
  name: string;
  statuses: Record<Role, string>;
}

export interface TimelineEntry {
  author: string;
  date: string;
  /** null for human comments (no [AGENT: …] tag). */
  agent: AgentComment | null;
  text: string;
}

export interface Task {
  id: string;
  name: string;
  project: Project;
  assignee: string;
  status: string;
  role: Role | null;
  statusSince: string;
  url: string;
  timeline: TimelineEntry[];
  /** Highest [ROUND: n] seen, or null before the first agent comment. */
  round: number | null;
  /** The newest agent comment. */
  last: AgentComment | null;
  /** Agent tool that ran the task (from the run log), null before the first run. */
  tool: string | null;
  /** Who ran it: "Rei – Mobile · Codex" from the newest [BY: …] tag, else the tool's name; null before a run. */
  by: string | null;
  /** The project's pipeline roles in order (from its profile). */
  roles: string[];
}

export const NOW = new Date(fixtures.now);

const projects: Project[] = fixtures.projects as Project[];

export function getTasks(): Task[] {
  return fixtures.tasks.map((t) => {
    const project = projects.find((p) => p.id === t.project)!;
    const timeline = t.comments.map((c) => ({ ...c, agent: parseAgentComment(c.text) }));
    const agentComments = timeline.flatMap((e) => (e.agent ? [e.agent] : []));
    const rounds = agentComments.flatMap((a) => (a.round === null ? [] : [a.round]));
    const role = ROLES.find((r) => project.statuses[r].toLowerCase() === t.status.toLowerCase()) ?? null;
    return {
      id: t.id,
      name: t.name,
      project,
      assignee: t.assignee,
      status: t.status,
      role,
      statusSince: t.statusSince,
      url: `https://app.clickup.com/t/${t.id}`,
      timeline,
      round: rounds.length ? Math.max(...rounds) : null,
      last: agentComments.at(-1) ?? null,
      tool: t.tool,
      by: agentComments.findLast((a) => a.by)?.by ?? (t.tool ? (TOOL_LABEL[t.tool] ?? t.tool) : null),
      roles: libraryProjects.find((p) => p.id === t.project)?.roles ?? ['coder', 'reviewer', 'tester'],
    };
  });
}

export const getTask = (id: string) => getTasks().find((t) => t.id === id) ?? null;
export const getProjects = () => projects;

/** "3h 10m", "2d 4h" — time since `iso` at fixture time NOW. */
export function since(iso: string): string {
  const minutes = Math.max(0, Math.round((NOW.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type Tone = 'green' | 'amber' | 'red' | 'neutral';

export function resultTone(result: AgentResult): Tone {
  if (result === 'APPROVED' || result === 'PASS') return 'green';
  if (result === 'CHANGES_NEEDED') return 'amber';
  if (result === 'FAIL' || result === 'NEEDS_HUMAN') return 'red';
  return 'neutral';
}
