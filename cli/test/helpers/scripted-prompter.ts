// A Prompter that answers from a script and records every question, so tests can assert the
// questions, their order, their defaults and their validators without a terminal.
import {
  type ConfirmQuestion,
  type InputQuestion,
  type MultiSelectQuestion,
  type Prompter,
  type SelectQuestion,
  UserAborted,
} from "../../src/cli/tui/prompter.ts";

export type Asked =
  | { kind: "input"; q: InputQuestion }
  | { kind: "confirm"; q: ConfirmQuestion }
  | { kind: "select"; q: SelectQuestion }
  | { kind: "multiselect"; q: MultiSelectQuestion };

/** An answer: the value, ACCEPT for the default, or ABORT to cancel. */
export const ACCEPT = Symbol("accept");
export const ABORT = Symbol("abort");
type Answer = string | boolean | string[] | typeof ACCEPT | typeof ABORT;

export function scripted(answers: Answer[]): { prompter: Prompter; asked: Asked[] } {
  const asked: Asked[] = [];
  const queue = [...answers];
  const next = (title: string): Answer => {
    const a = queue.shift();
    if (a === undefined) throw new Error(`no scripted answer for ${JSON.stringify(title)}`);
    if (a === ABORT) throw new UserAborted();
    return a;
  };
  const prompter: Prompter = {
    async input(q) {
      asked.push({ kind: "input", q });
      const a = next(q.title);
      const v = a === ACCEPT ? q.value : (a as string);
      const problem = q.validate?.(v);
      if (problem !== undefined)
        throw new Error(`validation rejected ${JSON.stringify(v)}: ${problem}`);
      return v;
    },
    async confirm(q) {
      asked.push({ kind: "confirm", q });
      const a = next(q.title);
      return a === ACCEPT ? q.value : (a as boolean);
    },
    async select(q) {
      asked.push({ kind: "select", q });
      const a = next(q.title);
      const v = a === ACCEPT ? q.value : (a as string);
      if (!q.options.some((o) => o.value === v))
        throw new Error(`${v} is not an option of ${q.title}`);
      return v;
    },
    async multiselect(q) {
      asked.push({ kind: "multiselect", q });
      const a = next(q.title);
      const v =
        a === ACCEPT ? q.options.filter((o) => o.selected).map((o) => o.value) : (a as string[]);
      const problem = q.validate?.(v);
      if (problem !== undefined) throw new Error(`validation rejected: ${problem}`);
      return v;
    },
  };
  return { prompter, asked };
}

export const titles = (asked: Asked[]): string[] => asked.map((a) => a.q.title);
