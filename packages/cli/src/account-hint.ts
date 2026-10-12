/**
 * Hint for the most common setup mistake: ClickUp in the browser is logged in to another account
 * (or another workspace) than the token, so statuses or lists made there are invisible to the kit.
 */
import type { ClickUpClient } from '@tossana/agents-core';

/** The token's workspaces as "workspace <name>, ID <id>"; one GET, only called after a failure. */
export async function wrongAccountHint(client: ClickUpClient): Promise<string> {
  let where = "the token's workspace (run: tossana-agents clickup spaces)";
  try {
    const teams = await client.getWorkspaces();
    if (teams.length) where = teams.map((t) => `workspace ${t.name}, ID ${t.id}`).join('; ');
  } catch {
    // keep the generic text: the hint must never hide the real error
  }
  return (
    `Check that ClickUp in your browser is logged in to the same account as your token (${where}). ` +
    'Changes made in another account or workspace are not visible to this token.'
  );
}
