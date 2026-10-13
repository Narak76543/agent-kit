/**
 * The feedback loop (plan Phase 10, step 5): the owner's comment sends a finished task back to the coder.
 * - `tossana-agents feedback <taskId> "text"` posts the comment (as the owner) and moves the task to coding;
 * - `watch` finds such tasks (coding, a human comment after the pipeline's last result) and resumes them with that
 *   comment as the coder's top-priority instruction, then the normal review and test again.
 */
import { existsSync } from 'node:fs';
import {
  KitError,
  appendHandoff,
  isClosedType,
  isValidTaskId,
  parseAgentComment,
  statusForRole,
  type AgentConfig,
  type ClickUpClient,
  type ClickUpComment,
} from '@tossana/agents-core';
import { worktreePath } from './worktrees.js';

export interface PendingFeedback {
  /** All human comments after the pipeline's last result, oldest first. */
  text: string;
  /** The newest of them: watch remembers it, so the same feedback is handled once. */
  commentId: string;
}

/**
 * Human feedback waiting for the agents: comments without an agent header after the orchestrator's final result
 * (PASS or NEEDS_HUMAN, i.e. the pipeline had finished). Null when there is none.
 */
export function pendingFeedback(comments: ClickUpComment[]): PendingFeedback | null {
  let lastFinal = -1;
  comments.forEach((c, i) => {
    const a = parseAgentComment(c.comment_text ?? '');
    if (a && a.agent === 'orchestrator' && (a.result === 'PASS' || a.result === 'NEEDS_HUMAN')) lastFinal = i;
  });
  if (lastFinal < 0) return null;
  const after = comments.slice(lastFinal + 1);
  // A newer agent comment means the agents already picked it up.
  if (after.some((c) => parseAgentComment(c.comment_text ?? ''))) return null;
  const human = after.filter((c) => (c.comment_text ?? '').trim());
  if (!human.length) return null;
  return { text: human.map((c) => c.comment_text!.trim()).join('\n\n'), commentId: String(human.at(-1)!.id) };
}

/** Posts the owner's comment, moves the task back to coding and notes it in the handoff file. */
export async function sendFeedback(
  cwd: string,
  config: AgentConfig,
  client: ClickUpClient,
  taskId: string,
  text: string,
  now: Date,
): Promise<{ status: string }> {
  if (!isValidTaskId(taskId)) throw new KitError(`invalid task id "${taskId}"`);
  const feedback = text.trim();
  if (!feedback) throw new KitError('write the feedback: tossana-agents feedback <taskId> "what to change"');
  const task = await client.getTask(taskId, { subtasks: false });
  if (isClosedType(task.status?.type)) {
    throw new KitError(`${taskId} is closed ("${task.status?.status}"). Reopen it in ClickUp first.`);
  }
  if (parseAgentComment(feedback)) throw new KitError('feedback must be your own words, not an [AGENT: …] comment');
  await client.postComment(taskId, feedback);
  const coding = statusForRole(config, 'coding');
  await client.setStatus(taskId, coding);
  // The handoff file lives where the task runs: its worktree when there is one.
  const dir = existsSync(worktreePath(cwd, taskId)) ? worktreePath(cwd, taskId) : cwd;
  appendHandoff(dir, taskId, 'Owner feedback (top priority)', feedback, now);
  return { status: coding };
}
