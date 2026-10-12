/**
 * Team library preview (plan Phase 7). v1 reads fixtures/library.json; later this reads the
 * tossana-agent-library repo at the version each project pins. The agents' permissions in the fixture are
 * the real rendered OpenCode agent files of a sample project.
 */
import library from '../fixtures/library.json';

export type Permission = Record<string, string | Record<string, string>>;

export interface Agent {
  name: string;
  title: string;
  preset: string;
  order: number;
  mode: string;
  steps: number;
  description: string;
  purpose: string;
  permission: Permission;
  skills: string[];
  mcp: string[];
  tools: string[];
}

export interface Skill {
  name: string;
  scope: 'team' | 'user' | 'project';
  types: string[];
  description: string;
  body: string;
}

export interface McpServer {
  id: string;
  name: string;
  status: 'approved' | 'pending';
  url: string;
  transport: string;
  access: string;
  tools: string[];
  auth: string;
  notes: string;
}

export interface LibraryProject {
  id: string;
  name: string;
  type: string;
  library: string;
  tools: string[];
  roles: string[];
  skills: string[];
  mcp: string[];
  figma: boolean;
}

export const LIBRARY_VERSION = library.version;
// JSON imports type each agent's permission block differently; the fixture is generated from real agent files.
export const agents = [...(library.agents as unknown as Agent[])].sort((a, b) => a.order - b.order);
export const skills = library.skills as Skill[];
export const mcpServers = library.mcp as McpServer[];
export const libraryProjects = library.projects as LibraryProject[];
export const lockedRules = library.lockedRules;

export const getAgent = (name: string) => agents.find((a) => a.name === name) ?? null;
export const getSkill = (name: string) => skills.find((s) => s.name === name) ?? null;
export const getMcp = (id: string) => mcpServers.find((m) => m.id === id) ?? null;
export const projectsUsing = (key: 'roles' | 'skills' | 'mcp', value: string) =>
  libraryProjects.filter((p) => p[key].includes(value));

export const TOOL_LABEL: Record<string, string> = {
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export const PRESET_LABEL: Record<string, string> = {
  coordinator: 'Coordinator',
  'edit-code': 'Edit code',
  'read-only': 'Read only',
  'edit-tests-only': 'Edit tests only',
};

export const SCOPE_LABEL: Record<Skill['scope'], string> = {
  team: 'Team',
  project: 'Project',
  user: 'User (local)',
};
