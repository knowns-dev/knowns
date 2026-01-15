#!/usr/bin/env bun
/**
 * Knowns.dev CLI
 * "What your AI should have knowns."
 *
 * Open-source CLI for dev teams
 * Tasks - Time - Sync
 */

import {
	agentsCommand,
	boardCommand,
	browserCommand,
	configCommand,
	docCommand,
	initCommand,
	mcpCommand,
	searchCommand,
	taskCommand,
	timeCommand,
} from "@commands/index";
import { notifyCliUpdate } from "@utils/update-notifier";
import chalk from "chalk";
import { Command } from "commander";
import packageJson from "../package.json";

// ASCII art banner for KNOWNS
const BANNER = `
▄▄▄   ▄▄▄ ▄▄▄    ▄▄▄   ▄▄▄▄▄   ▄▄▄▄  ▄▄▄  ▄▄▄▄ ▄▄▄    ▄▄▄  ▄▄▄▄▄▄▄
███ ▄███▀ ████▄  ███ ▄███████▄ ▀███  ███  ███▀ ████▄  ███ █████▀▀▀
███████   ███▀██▄███ ███   ███  ███  ███  ███  ███▀██▄███  ▀████▄
███▀███▄  ███  ▀████ ███▄▄▄███  ███▄▄███▄▄███  ███  ▀████    ▀████
███  ▀███ ███    ███  ▀█████▀    ▀████▀████▀   ███    ███ ███████▀
`;

function showBanner(): void {
	console.log(chalk.cyan(BANNER));
	console.log(chalk.bold("  Knowns CLI") + chalk.gray(` v${packageJson.version}`));
	console.log(chalk.gray('  "What your AI should have knowns."'));
	console.log();
	console.log(chalk.gray("  Open-source CLI for dev teams"));
	console.log(chalk.gray("  Tasks • Time • Docs • Sync"));
	console.log();
	console.log(chalk.yellow("  Quick Start:"));
	console.log(chalk.gray("    knowns init           Initialize project"));
	console.log(chalk.gray("    knowns task list      List all tasks"));
	console.log(chalk.gray("    knowns browser        Open web UI"));
	console.log(chalk.gray("    knowns --help         Show all commands"));
	console.log();
	console.log(chalk.gray("  Homepage:  ") + chalk.cyan("https://knowns.dev"));
	console.log(chalk.gray("  Documents: ") + chalk.cyan("https://cli.knowns.dev/docs"));
	console.log();
}

const program = new Command();

program
	.name("knowns")
	.description("CLI tool for dev teams to manage tasks, track time, and sync")
	.version(packageJson.version)
	.enablePositionalOptions();

// Add commands
program.addCommand(initCommand);
program.addCommand(taskCommand);
program.addCommand(boardCommand);
program.addCommand(browserCommand);
program.addCommand(searchCommand);
program.addCommand(timeCommand);
program.addCommand(docCommand);
program.addCommand(configCommand);
program.addCommand(agentsCommand);
program.addCommand(mcpCommand);

// Show banner if no arguments provided
const args = process.argv.slice(2);

if (args.length === 0) {
	showBanner();
	await notifyCliUpdate({ currentVersion: packageJson.version, args });
} else {
	program.hook("postAction", async () => {
		await notifyCliUpdate({ currentVersion: packageJson.version, args });
	});
	await program.parseAsync();
}
