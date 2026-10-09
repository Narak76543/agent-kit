/**
 * Plain-English fixes for ClickUp errors people actually hit, especially token problems.
 * Error codes from the official list: https://developer.clickup.com/docs/common_errors
 */
import { ClickUpApiError } from '../errors.js';

const NEW_TOKEN_STEPS =
  'Create a new token: in ClickUp click your avatar → Settings → Apps → API Token → Generate (or Regenerate). ' +
  'Then put it in .env as CLICKUP_API_TOKEN=pk_... (no quotes, no spaces) and run: tossana-agents doctor';

const TOKEN_NOT_FOUND = new Set(['OAUTH_019', 'OAUTH_021', 'OAUTH_025', 'OAUTH_077']);
const TEAM_NOT_AUTHORIZED = new Set([
  'OAUTH_023',
  'OAUTH_026',
  'OAUTH_027',
  ...Array.from({ length: 17 }, (_, i) => `OAUTH_0${29 + i}`), // OAUTH_029 … OAUTH_045
]);

export function errorCode(error: unknown): string | null {
  if (!(error instanceof ClickUpApiError)) return null;
  const body = error.body as { ECODE?: unknown } | null;
  return typeof body?.ECODE === 'string' ? body.ECODE : null;
}

/** A fix to show under a ClickUp error, or `null` when there is nothing specific to say. */
export function clickUpErrorHint(error: unknown): string | null {
  if (!(error instanceof ClickUpApiError)) return null;
  const code = errorCode(error);
  if (code && TOKEN_NOT_FOUND.has(code)) {
    return `Your ClickUp token is not valid any more (${code}: token not found). It was probably revoked or regenerated. ${NEW_TOKEN_STEPS}`;
  }
  if (code && TEAM_NOT_AUTHORIZED.has(code)) {
    return (
      `Your token cannot access this Workspace (${code}: team not authorized). Check that the ClickUp user who owns the ` +
      'token is a member of the Workspace that has this list, or create the token while logged in as the right user.'
    );
  }
  if (code === 'OAUTH_017') return `No token was sent (${code}). ${NEW_TOKEN_STEPS}`;
  if (error.status === 401)
    return `ClickUp rejected the token (HTTP 401${code ? `, ${code}` : ''}). ${NEW_TOKEN_STEPS}`;
  if (error.status === 403) {
    return 'Your token has no access to this item. Ask a Workspace admin to share the list/task with your ClickUp user.';
  }
  if (error.status === 404) return 'Not found. Check the ID; custom task IDs (like EKM-12) need clickup.customTaskIds.';
  if (error.status === 429)
    return 'ClickUp rate limit reached (100 requests/minute per token). Wait a minute and try again.';
  return null;
}

/** Problems you can see in the token text itself, before calling ClickUp. */
export function tokenFormatProblem(token: string | undefined): string | null {
  if (!token) return `CLICKUP_API_TOKEN is missing in .env. ${NEW_TOKEN_STEPS}`;
  if (/^["']|["']$/.test(token)) return 'CLICKUP_API_TOKEN has quotes around it. Remove the quotes in .env.';
  if (/\s/.test(token)) return 'CLICKUP_API_TOKEN contains spaces. Copy it again without spaces.';
  if (!token.startsWith('pk_')) {
    return 'CLICKUP_API_TOKEN does not start with "pk_". Use a personal API token (Settings → Apps → API Token).';
  }
  return null;
}
