/** Positional-argument validators (cobra args.go). Return an error message, or undefined if fine. */

import type { Command } from "./command.ts";
import { goQuote } from "./gofmt.ts";

export type PositionalArgs = (cmd: Command, args: string[]) => string | undefined;

export const arbitraryArgs: PositionalArgs = () => undefined;

export const noArgs: PositionalArgs = (cmd, args) =>
  args.length > 0
    ? `unknown command ${goQuote(args[0] ?? "")} for ${goQuote(cmd.commandPath())}`
    : undefined;

export const minimumNArgs =
  (n: number): PositionalArgs =>
  (_cmd, args) =>
    args.length < n ? `requires at least ${n} arg(s), only received ${args.length}` : undefined;

export const maximumNArgs =
  (n: number): PositionalArgs =>
  (_cmd, args) =>
    args.length > n ? `accepts at most ${n} arg(s), received ${args.length}` : undefined;

export const exactArgs =
  (n: number): PositionalArgs =>
  (_cmd, args) =>
    args.length !== n ? `accepts ${n} arg(s), received ${args.length}` : undefined;

export const rangeArgs =
  (min: number, max: number): PositionalArgs =>
  (_cmd, args) =>
    args.length < min || args.length > max
      ? `accepts between ${min} and ${max} arg(s), received ${args.length}`
      : undefined;
