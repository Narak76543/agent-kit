/** Base error for the kit. `exitCode` is what the CLI should exit with. */
export class KitError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A config or .env problem the user must fix. */
export class ConfigError extends KitError {}

/** A ClickUp HTTP error after retries were used up. */
export class ClickUpApiError extends KitError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`ClickUp ${status} on ${method} ${path}: ${JSON.stringify(body)}`);
  }
}

/** The Done guard refused a status change. Exit code 2, as in the original clickup.ts. */
export class DoneGuardError extends KitError {
  constructor(
    readonly status: string,
    readonly reason: string,
  ) {
    super(
      `BLOCKED: agents may not set status "${status}": ${reason}.\n` +
        'Only the human owner marks tasks Done. Do not look for a way around this; report it and stop.',
      2,
    );
  }
}
