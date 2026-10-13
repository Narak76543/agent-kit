/**
 * Template values that depend on the pipeline roles (plan Phase 7). With the default roles
 * (coder → reviewer → tester) every value is exactly the text the templates had before roles became
 * configurable; the golden tests check that byte for byte.
 */
import {
  pipelineRoles,
  usesDefaultRoles,
  type AgentConfig,
  type PipelineRole,
  type ResolvedSkill,
} from '@tossana/agents-core';
import { readTemplate } from './templates.js';

/** Which template a role is rendered from. */
export function roleTemplate(role: PipelineRole): 'planner' | 'coder' | 'reviewer' | 'tester' {
  if (role.kind === 'plan') return 'planner';
  if (role.preset === 'edit-code') return 'coder';
  return role.preset === 'read-only' ? 'reviewer' : 'tester';
}

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
const code = (s: string) => `\`${s}\``;
export const roleTitle = (name: string) => `${name[0]!.toUpperCase()}${name.slice(1).replace(/-/g, ' ')}`;

/** Values for the orchestrator and the Figma snippet (same for every file). */
export function pipelineVars(config: AgentConfig): Record<string, string> {
  const roles = pipelineRoles(config);
  const names = roles.map((r) => r.name);
  const figmaRoles = roles.filter((r) => r.mcp.includes('figma')).map((r) => `the ${code(r.name)}`);
  const base = {
    'pipeline.rolesText': list(names),
    'perm.taskRoles': names.map((n) => `    ${n}: allow`).join('\n'),
    'pipeline.firstRole': names[0]!,
    'pipeline.coder': roles.find((r) => r.kind === 'code')!.name,
    'pipeline.rolesList': names.join(', '),
    // The default text wraps after "the"; it sits inside a paragraph of the Figma snippet.
    'figma.roleNames':
      figmaRoles.length === 2 ? `${figmaRoles[0]} and the\n${figmaRoles[1]!.slice(4)}` : list(figmaRoles),
  };
  if (usesDefaultRoles(config)) {
    return {
      ...base,
      'pipeline.loop': readTemplate('orchestrator/loop-default.md'),
      'pipeline.successRule': 'APPROVED + PASS in the same round',
      'pipeline.successShort': 'APPROVED + PASS',
      'pipeline.manualFrom': 'tester',
    };
  }
  const testers = roles.filter((r) => r.preset === 'edit-tests-only').map((r) => r.name);
  return {
    ...base,
    'pipeline.loop': customLoop(roles, config.pipeline.maxRounds),
    'pipeline.successRule': 'every check passed in the same round',
    'pipeline.successShort': 'all checks passing',
    'pipeline.manualFrom': testers.length ? list(testers) : 'the checks',
  };
}

/** The orchestrator's loop section for custom roles (plan once, then code → checks, max N rounds). */
function customLoop(roles: PipelineRole[], maxRounds: number): string {
  const planners = roles.filter((r) => r.kind === 'plan');
  const coders = roles.filter((r) => r.kind === 'code');
  const checks = roles.filter((r) => r.kind === 'check');
  const fixer = coders[0]!.name;
  const out: string[] = [`## 1. Loop — round = 1 … ${maxRounds}`, ''];

  if (planners.length) {
    out.push(
      '**Before round 1: plan.** Only once per run. For each planning role, in order:',
      '',
      ...planners.map(
        (r) =>
          `- \`cu status <taskId> ${r.status}\`. Invoke \`${r.name}\` with task ID, task name + description, spec pages and FR/AC codes.` +
          ` Wait for its \`[AGENT: ${r.name}] [RESULT: PLANNED]\` report.`,
      ),
      '',
      'Give the plans to every later role in each prompt. If a planner reports a blocking question under Issues, stop as',
      '**Blocked** (see step 2).',
      '',
    );
  }

  out.push(
    `**a. Code.** For each coding role, in order (${coders.map((r) => code(r.name)).join(', ')}): \`cu status <taskId> coding\`,`,
    'then invoke it with: task ID, round number, task name + description, spec pages and FR/AC codes, the plan (if any),',
    'and (round > 1) the exact issues from the checks of the previous round, plus any human feedback. Wait for its',
    '`[AGENT: <role>] [RESULT: DONE_CODING]` report. If it could not finish (it says so, or there are no new commits and no',
    'explanation), treat the round as failed and go to the next round with that as feedback.',
    '',
    '**b. Checks**, in order:',
    '',
  );
  checks.forEach((r, i) => {
    const ok = r.preset === 'read-only' ? 'APPROVED' : 'PASS';
    const bad = r.preset === 'read-only' ? 'CHANGES_NEEDED' : 'FAIL';
    const extra = r.preset === 'edit-tests-only' ? ' and the acceptance criteria' : '';
    out.push(
      `${i + 1}. \`cu status <taskId> ${r.status}\`. Invoke \`${r.name}\` with task ID, round, spec pages${extra}.`,
      `   - \`${bad}\` → \`cu status <taskId> coding\`, next round with ${code(r.name)}'s Issues as feedback for ${code(fixer)}.`,
      `   - \`${ok}\` → ${i === checks.length - 1 ? 'go to step 2 (success).' : 'next check.'}`,
    );
  });
  if (!checks.length) out.push('(No checks configured: after the coding roles, go to step 2 (success).)');
  return out.join('\n');
}

/** Values for one role's own file (OpenCode agent and Antigravity wrapper). */
export function roleVars(
  config: AgentConfig,
  role: PipelineRole,
  skills: Map<string, ResolvedSkill>,
  globalVars: Record<string, string>,
): Record<string, string> {
  const roles = pipelineRoles(config);
  const index = roles.findIndex((r) => r.name === role.name);
  const paths = role.skills.map((s) => code(skills.get(s)?.path ?? `.agents/skills/${s}/SKILL.md`));
  const usesFigma = role.mcp.includes('figma');
  return {
    'role.name': role.name,
    'role.title': roleTitle(role.name),
    'role.purpose': role.purpose ? `\n**Your purpose in this project:** ${role.purpose}` : '',
    'role.skillRef': paths.length ? paths.join(', ') : '`AGENTS.md` (this role has no skill file)',
    // For templates that read AGENTS.md first and then the role's skills, if it has any.
    'role.skillRead': paths.length ? ` Then read the skill ${paths.join(', ')} and follow it.` : '',
    'role.next': roles[index + 1]?.name ?? 'orchestrator',
    'role.fixer': roles.find((r) => r.kind === 'code')!.name,
    'role.results': role.kind === 'plan' ? 'PLANNED' : 'APPROVED | CHANGES_NEEDED',
    // Antigravity wrapper description (planners reuse the read-only wrapper).
    'role.agDescription':
      role.kind === 'plan'
        ? `Read-only planner for ${config.project.name}. Reads the task, specs and code before coding starts and writes a short plan. Has no file-editing tools. Started by tossana-agents run, or by the /start-task orchestrator in the IDE.`
        : `Strict read-only code reviewer for ${config.project.name}. Reviews the task branch diff against the ClickUp task, specs and AGENTS.md, and returns APPROVED or CHANGES_NEEDED. Has no file-editing tools. Started by tossana-agents run, or by the /start-task orchestrator in the IDE.`,
    'perm.figma': usesFigma ? globalVars['perm.figma']! : '',
    'figma.coder': usesFigma ? globalVars['figma.coder']! : '',
    'figma.reviewer': usesFigma ? globalVars['figma.reviewer']! : '',
  };
}
