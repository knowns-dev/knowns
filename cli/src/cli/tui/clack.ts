// The terminal Prompter: @clack/prompts behind the interface in prompter.ts. This module is only
// ever imported dynamically, from createPrompter, so @clack stays out of the startup path.
import { type ChoiceOption, type Prompter, UserAborted } from "./prompter.ts";
import { openTerminal } from "./terminal.ts";

type Clack = typeof import("@clack/prompts");

function describe(title: string, description: string | undefined): string {
  return description && description !== "" ? `${title}\n${description}` : title;
}

function mapOptions(options: ChoiceOption[]) {
  return options.map((o) => ({ value: o.value, label: o.label }));
}

/** huh returns a multi-select's values in option order, however they were toggled. */
function inOptionOrder(values: string[], options: ChoiceOption[]): string[] {
  return options.map((o) => o.value).filter((v) => values.includes(v));
}

export async function clackPrompter(): Promise<Prompter> {
  const term = openTerminal();
  const p: Clack = await import("@clack/prompts");
  const io = { input: term.input, output: term.output };

  const settle = <T>(v: unknown): T => {
    if (p.isCancel(v)) throw new UserAborted();
    return v as T;
  };

  return {
    async input(q) {
      const answer = settle<string | undefined>(
        await (q.password
          ? p.password({
              ...io,
              message: describe(q.title, q.description),
              validate: q.validate ? (v) => q.validate?.(v ?? "") : undefined,
            })
          : p.text({
              ...io,
              message: describe(q.title, q.description),
              initialValue: q.value,
              placeholder: q.placeholder,
              validate: q.validate ? (v) => q.validate?.(v ?? "") : undefined,
            })),
      );
      return answer ?? "";
    },
    async confirm(q) {
      return settle<boolean>(
        await p.confirm({
          ...io,
          message: describe(q.title, q.description),
          initialValue: q.value,
        }),
      );
    },
    async select(q) {
      return settle<string>(
        await p.select<string>({
          ...io,
          message: describe(q.title, q.description),
          options: mapOptions(q.options),
          initialValue: q.value,
        }),
      );
    },
    async multiselect(q) {
      let current = q.options.filter((o) => o.selected).map((o) => o.value);
      for (;;) {
        const picked = settle<string[]>(
          await p.multiselect<string>({
            ...io,
            message: describe(q.title, q.description),
            options: mapOptions(q.options),
            initialValues: current,
            // "Select at least one" is clack's own in-prompt validation, which (like huh) keeps
            // the cursor and the toggles when it rejects an empty submit.
            required: q.validate?.([]) !== undefined,
          }),
        );
        const problem = q.validate?.(picked);
        if (problem === undefined) return inOptionOrder(picked, q.options);
        p.log.error(problem, { output: term.output });
        current = picked;
      }
    },
  };
}
