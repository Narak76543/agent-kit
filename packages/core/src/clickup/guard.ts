/**
 * The Done guard: agents may never move a task to Done (or anything closed). Three layers:
 *   1. the name must not contain done / complete / closed;
 *   2. the name must be in the allow-list (the statuses mapped to roles in agent.config.json);
 *   3. the list's real status must not have ClickUp type "done" or "closed".
 * Layers 1 and 2 run before any network call. ClickUpClient.setStatus always runs all three,
 * so no caller can bypass them.
 */
import { DoneGuardError } from '../errors.js';

export const FORBIDDEN_WORDS = ['done', 'complete', 'closed'] as const;
export const CLOSED_STATUS_TYPES = ['done', 'closed'] as const;

const norm = (s: string) => s.trim().toLowerCase();

/** Why an agent may not set this status name, or `null` if layers 1 and 2 allow it. */
export function statusNameRefusal(status: string, allowed: readonly string[]): string | null {
  const s = norm(status);
  if (!s) return 'the status is empty';
  const word = FORBIDDEN_WORDS.find((w) => s.includes(w));
  if (word) return `"${status}" contains a forbidden word (${FORBIDDEN_WORDS.join('/')})`;
  const allowList = allowed.map(norm);
  if (!allowList.includes(s)) return `"${status}" is not an agent status (${allowList.join(', ')})`;
  return null;
}

/** Layers 1 and 2. Throws DoneGuardError. */
export function assertStatusNameAllowed(status: string, allowed: readonly string[]): void {
  const why = statusNameRefusal(status, allowed);
  if (why) throw new DoneGuardError(status, why);
}

export function isClosedType(type: unknown): boolean {
  return (CLOSED_STATUS_TYPES as readonly string[]).includes(norm(String(type ?? '')));
}

/** Layer 3. Throws DoneGuardError when ClickUp says the status is a done/closed type. */
export function assertStatusTypeAllowed(status: { status: string; type?: string | null }): void {
  if (isClosedType(status.type)) throw new DoneGuardError(status.status, `its ClickUp type is "${status.type}"`);
}

/** All three layers, for display (e.g. "agent can set" vs "HUMAN ONLY"). */
export function canAgentSet(status: { status: string; type?: string | null }, allowed: readonly string[]): boolean {
  return !isClosedType(status.type) && statusNameRefusal(status.status, allowed) === null;
}
