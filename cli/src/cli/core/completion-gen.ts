/**
 * Shell completion script generators (cobra v1.10.2 bash_completionsV2.go, zsh_completions.go,
 * fish_completions.go, powershell_completions.go). The templates live in completion-scripts.ts;
 * this fills in the program name, the request command and the directive values exactly as the
 * Go fmt.Sprintf calls do.
 */
import {
  activeHelpEnvVar,
  SHELL_COMP_DIRECTIVE,
  SHELL_COMP_NO_DESC_REQUEST_CMD,
  SHELL_COMP_REQUEST_CMD,
} from "./completion-constants.ts";
import {
  BASH_TEMPLATE_0,
  FISH_TEMPLATE_0,
  FISH_TEMPLATE_1,
  POWERSHELL_TEMPLATE_0,
  ZSH_TEMPLATE_0,
} from "./completion-scripts.ts";

const ACTIVE_HELP_MARKER = "_activeHelp_ ";

/** The subset of Go's fmt.Sprintf the templates use: %[n]s, %[n]d, %s, %-36s, %-36[1]s and %%. */
function sprintf(format: string, args: Array<string | number>): string {
  let out = "";
  let next = 0;
  for (let i = 0; i < format.length; i++) {
    const c = format[i] as string;
    if (c !== "%") {
      out += c;
      continue;
    }
    if (format[i + 1] === "%") {
      out += "%";
      i++;
      continue;
    }
    const m = /^%(-?)(\d*)(?:\[(\d+)\])?([sd])/.exec(format.slice(i));
    if (!m) throw new Error(`unsupported format verb at ${i}`);
    const idx = m[3] !== undefined ? Number(m[3]) - 1 : next;
    next = idx + 1;
    let text = String(args[idx]);
    const width = m[2] === "" ? 0 : Number(m[2]);
    if (text.length < width) {
      text = m[1] === "-" ? text.padEnd(width) : text.padStart(width);
    }
    out += text;
    i += m[0].length - 1;
  }
  return out;
}

function directives(): number[] {
  const d = SHELL_COMP_DIRECTIVE;
  return [d.error, d.noSpace, d.noFileComp, d.filterFileExt, d.filterDirs, d.keepOrder];
}

function requestCmd(includeDesc: boolean): string {
  return includeDesc ? SHELL_COMP_REQUEST_CMD : SHELL_COMP_NO_DESC_REQUEST_CMD;
}

function nameForVar(name: string): string {
  return name.replaceAll("-", "_").replaceAll(":", "_");
}

export function genBashCompletion(name: string, includeDesc: boolean): string {
  return sprintf(BASH_TEMPLATE_0, [
    name,
    requestCmd(includeDesc),
    ...directives(),
    ACTIVE_HELP_MARKER,
  ]);
}

export function genZshCompletion(name: string, includeDesc: boolean): string {
  return sprintf(ZSH_TEMPLATE_0, [
    name,
    requestCmd(includeDesc),
    ...directives(),
    ACTIVE_HELP_MARKER,
  ]);
}

export function genFishCompletion(name: string, includeDesc: boolean): string {
  return (
    sprintf(FISH_TEMPLATE_0, [name]) +
    sprintf(FISH_TEMPLATE_1, [
      nameForVar(name),
      name,
      requestCmd(includeDesc),
      ...directives(),
      activeHelpEnvVar(name),
    ])
  );
}

export function genPowerShellCompletion(name: string, includeDesc: boolean): string {
  return sprintf(POWERSHELL_TEMPLATE_0, [
    name,
    nameForVar(name),
    requestCmd(includeDesc),
    ...directives(),
    activeHelpEnvVar(name),
  ]);
}
