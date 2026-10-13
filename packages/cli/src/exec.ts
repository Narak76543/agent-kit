/**
 * Running other programs (git, opencode, pnpm…). Uses cross-spawn without a shell: on Windows
 * Node 20+ refuses to spawn .cmd shims (npm-installed CLIs) directly, and cross-spawn handles
 * them with correct cmd.exe quoting.
 */
import spawn from 'cross-spawn';

export interface ExecResult {
  /** Exit code; null when the program could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started (e.g. not installed). */
  error?: Error;
}

export type Exec = (
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; /** Added to the process environment. */ env?: Record<string, string> },
) => ExecResult;

export const exec: Exec = (cmd, args, options = {}) => {
  const res = spawn.sync(cmd, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    windowsHide: true,
  });
  return {
    code: res.status,
    stdout: (res.stdout ?? '').toString(),
    stderr: (res.stderr ?? '').toString(),
    error: res.error ?? undefined,
  };
};

/** First line of `<cmd> --version`, or null if it is not installed / fails. */
export function versionOf(run: Exec, cmd: string, cwd?: string): string | null {
  const res = run(cmd, ['--version'], { cwd, timeoutMs: 15_000 });
  if (res.error || res.code !== 0) return null;
  return (res.stdout || res.stderr).trim().split(/\r?\n/)[0] ?? '';
}
