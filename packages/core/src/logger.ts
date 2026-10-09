/**
 * The only place core writes output. Everything is passed through `redact` so a ClickUp
 * token can never reach the console or a log file, even inside an error message.
 */

// Personal ClickUp tokens look like pk_<digits>_<alphanumerics>.
const TOKEN_PATTERN = /\bpk_[A-Za-z0-9_]+/g;
const MIN_SECRET_LENGTH = 8;

export const REDACTED = '[REDACTED]';

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(TOKEN_PATTERN, REDACTED);
  for (const secret of secrets) {
    if (secret && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join(REDACTED);
  }
  return out;
}

export interface Logger {
  /** Normal output (stdout). */
  info(message: string): void;
  /** Warnings and progress notes (stderr, so stdout stays clean for JSON). */
  warn(message: string): void;
  error(message: string): void;
  /** Redacts with this logger's secrets; use it before writing to files. */
  redact(text: string): string;
  /** Registers another value to hide, e.g. a token loaded after the logger was created. */
  addSecret(secret: string | undefined): void;
}

export interface LoggerOptions {
  secrets?: string[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const secrets = [...(options.secrets ?? [])];
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const clean = (text: string) => redact(text, secrets);
  return {
    info: (m) => stdout(clean(m)),
    warn: (m) => stderr(clean(m)),
    error: (m) => stderr(clean(m)),
    redact: clean,
    addSecret(secret) {
      if (secret && !secrets.includes(secret)) secrets.push(secret);
    },
  };
}

/** A logger that drops everything; the default for library calls. */
export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  redact: (text) => redact(text),
  addSecret() {},
};
