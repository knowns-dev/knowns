// `knowns completion bash|zsh|fish|powershell`: cobra's built-in command (InitDefaultCompletionCmd).
// The scripts are only loaded when one is requested.
import { noArgs } from "../core/args.ts";
import { Command, type RunFunc } from "../core/command.ts";
import { noFileCompletions } from "../core/completion-constants.ts";

const SHORT_DESC = (shell: string): string => `Generate the autocompletion script for ${shell}`;

type Generator = (name: string, includeDesc: boolean) => string;

function shellCommand(
  rootName: string,
  shell: string,
  long: string,
  gen: () => Promise<Generator>,
): Command {
  const run: RunFunc = async (cmd) => {
    const noDesc = cmd.getBool("no-descriptions");
    const generate = await gen();
    cmd.stdout(generate(rootName, !noDesc));
  };
  const cmd = new Command({
    use: shell,
    short: SHORT_DESC(shell),
    long,
    args: noArgs,
    disableFlagsInUseLine: shell === "bash",
    validArgsFunction: noFileCompletions,
    run,
  });
  cmd.flags().define("bool", "no-descriptions", "", "disable completion descriptions", false);
  return cmd;
}

/** Builds the `completion` command for a root named `rootName`. */
export function buildCompletionCommand(rootName: string): Command {
  const n = rootName;
  const completion = new Command({
    use: "completion",
    short: "Generate the autocompletion script for the specified shell",
    long: `Generate the autocompletion script for ${n} for the specified shell.\nSee each sub-command's help for details on how to use the generated script.\n`,
    args: noArgs,
    validArgsFunction: noFileCompletions,
  });

  const bash = shellCommand(
    n,
    "bash",
    `Generate the autocompletion script for the bash shell.

This script depends on the 'bash-completion' package.
If it is not installed already, you can install it via your OS's package manager.

To load completions in your current shell session:

	source <(${n} completion bash)

To load completions for every new session, execute once:

#### Linux:

	${n} completion bash > /etc/bash_completion.d/${n}

#### macOS:

	${n} completion bash > $(brew --prefix)/etc/bash_completion.d/${n}

You will need to start a new shell for this setup to take effect.
`,
    async () => (await import("../core/completion-gen.ts")).genBashCompletion,
  );

  const zsh = shellCommand(
    n,
    "zsh",
    `Generate the autocompletion script for the zsh shell.

If shell completion is not already enabled in your environment you will need
to enable it.  You can execute the following once:

	echo "autoload -U compinit; compinit" >> ~/.zshrc

To load completions in your current shell session:

	source <(${n} completion zsh)

To load completions for every new session, execute once:

#### Linux:

	${n} completion zsh > "\${fpath[1]}/_${n}"

#### macOS:

	${n} completion zsh > $(brew --prefix)/share/zsh/site-functions/_${n}

You will need to start a new shell for this setup to take effect.
`,
    async () => (await import("../core/completion-gen.ts")).genZshCompletion,
  );

  const fish = shellCommand(
    n,
    "fish",
    `Generate the autocompletion script for the fish shell.

To load completions in your current shell session:

	${n} completion fish | source

To load completions for every new session, execute once:

	${n} completion fish > ~/.config/fish/completions/${n}.fish

You will need to start a new shell for this setup to take effect.
`,
    async () => (await import("../core/completion-gen.ts")).genFishCompletion,
  );

  const powershell = shellCommand(
    n,
    "powershell",
    `Generate the autocompletion script for powershell.

To load completions in your current shell session:

	${n} completion powershell | Out-String | Invoke-Expression

To load completions for every new session, add the output of the above command
to your powershell profile.
`,
    async () => (await import("../core/completion-gen.ts")).genPowerShellCompletion,
  );

  completion.addCommand(bash, zsh, fish, powershell);
  return completion;
}
