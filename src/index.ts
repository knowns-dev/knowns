#!/usr/bin/env bun
/**
 * Knowns.dev CLI
 * "Know what your team knows."
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
	searchCommand,
	taskCommand,
	timeCommand,
} from "@commands/index";
import { Command } from "commander";

const program = new Command();

program.name("knowns").description("CLI tool for dev teams to manage tasks, track time, and sync").version("0.1.0");

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

program.parse();
