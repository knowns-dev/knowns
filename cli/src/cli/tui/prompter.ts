// The prompt seam of the interactive flows (init wizard, settings, setup selector).
//
// 0.34.1 drives these with charmbracelet/huh. The maintainer's decision (TSR-2P6ZDV, 2026-11-05) is
// the same behaviour, not pixel-identical screens: same questions, order, defaults, validation and
// written files. The flows are therefore written against this small interface; the real
// implementation (clack.ts) loads @clack/prompts lazily, and tests use a scripted prompter that
// records every question. Nothing here imports @clack, so the root command never pays for it.

export interface ChoiceOption {
  /** What the user reads. */
  label: string;
  /** What the flow gets back. */
  value: string;
  /** Pre-selected in a multi-select (huh: Option.Selected). */
  selected?: boolean;
}

export interface InputQuestion {
  title: string;
  description?: string;
  /** The pre-filled value (huh: Input.Value of the bound variable). */
  value: string;
  placeholder?: string;
  /** Returns an error message to reject the answer, or undefined to accept it. */
  validate?: (value: string) => string | undefined;
  /** Mask the typed characters (huh: EchoModePassword). */
  password?: boolean;
}

export interface ConfirmQuestion {
  title: string;
  description?: string;
  value: boolean;
}

export interface SelectQuestion {
  title: string;
  description?: string;
  options: ChoiceOption[];
  /** The option whose value matches starts highlighted. */
  value: string;
}

export interface MultiSelectQuestion {
  title: string;
  description?: string;
  /** Options with `selected: true` start checked. */
  options: ChoiceOption[];
  validate?: (values: string[]) => string | undefined;
}

export interface Prompter {
  input(q: InputQuestion): Promise<string>;
  confirm(q: ConfirmQuestion): Promise<boolean>;
  select(q: SelectQuestion): Promise<string>;
  multiselect(q: MultiSelectQuestion): Promise<string[]>;
}

/** The user cancelled (Esc or Ctrl-C): huh.ErrUserAborted. */
export class UserAborted extends Error {
  constructor() {
    super("user aborted");
    this.name = "UserAborted";
  }
}

export const isUserAborted = (e: unknown): e is UserAborted => e instanceof UserAborted;

let override: (() => Prompter | Promise<Prompter>) | undefined;

/** Tests install a scripted prompter here; pass undefined to restore the terminal one. */
export function setPrompterFactory(
  factory: (() => Prompter | Promise<Prompter>) | undefined,
): void {
  override = factory;
}

/**
 * The prompter the interactive commands use: the test override, else clack on the terminal. It is
 * created on the first question, so a command that fails before asking (and the "could not open a
 * new TTY" failure, which huh also reports only when the form starts) behaves like 0.34.1.
 */
export function createPrompter(): Prompter {
  let ready: Promise<Prompter> | undefined;
  const get = (): Promise<Prompter> => {
    ready ??= (async () => {
      if (override) return override();
      const { clackPrompter } = await import("./clack.ts");
      return clackPrompter();
    })();
    return ready;
  };
  return {
    input: async (q) => (await get()).input(q),
    confirm: async (q) => (await get()).confirm(q),
    select: async (q) => (await get()).select(q),
    multiselect: async (q) => (await get()).multiselect(q),
  };
}

/** huh's Select/MultiSelect need at least one option; an empty list is a programming error. */
export function requireOptions(title: string, options: ChoiceOption[]): void {
  if (options.length === 0) throw new Error(`prompt ${JSON.stringify(title)} has no options`);
}
