/** Interactive questions, behind an interface so tests can script the answers. */
import * as clack from '@clack/prompts';
import { KitError } from '@tossana/agents-core';

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompts {
  select<T extends string>(message: string, choices: Choice<T>[], initial?: T): Promise<T>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  /** Pick one or more. */
  multiselect<T extends string>(message: string, choices: Choice<T>[], initial: T[]): Promise<T[]>;
  text(message: string, initial?: string): Promise<string>;
  /** Masked input; the value is never echoed. */
  password(message: string): Promise<string>;
}

function unwrap<T>(value: T | symbol): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new KitError('cancelled', 130);
  return value as Exclude<T, symbol>;
}

export const clackPrompts: Prompts = {
  async select(message, choices, initial) {
    const options = choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint }));
    return unwrap(await clack.select({ message, options: options as never, initialValue: initial as never })) as never;
  },
  async multiselect(message, choices, initial) {
    const options = choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint }));
    return unwrap(
      await clack.multiselect({ message, options: options as never, initialValues: initial as never, required: true }),
    ) as never;
  },
  async confirm(message, initial = true) {
    return unwrap(await clack.confirm({ message, initialValue: initial }));
  },
  async text(message, initial) {
    return unwrap(await clack.text({ message, initialValue: initial, defaultValue: initial }));
  },
  async password(message) {
    return unwrap(await clack.password({ message, mask: '*' }));
  },
};
