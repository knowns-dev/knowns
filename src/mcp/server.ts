#!/usr/bin/env bun

/**
 * MCP Server for Knowns Task Management
 * Exposes task CRUD operations, time tracking, board management, and documentation via Model Context Protocol
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { FileStore } from "@storage/file-store";
import { normalizePath } from "@utils/index";
import matter from "gray-matter";

// Import handlers
import {
	boardTools,
	docTools,
	guidelineTools,
	handleAddTime,
	handleCreateDoc,
	handleCreateTask,
	handleCreateTemplate,
	handleGetBoard,
	handleGetDoc,
	handleGetGuideline,
	handleGetTask,
	handleGetTemplate,
	handleGetTimeReport,
	handleListDocs,
	handleListTasks,
	handleListTemplates,
	handleRunTemplate,
	handleSearchDocs,
	handleSearchTasks,
	handleStartTime,
	handleStopTime,
	handleUpdateDoc,
	handleUpdateTask,
	taskTools,
	templateTools,
	timeTools,
} from "./handlers";

import { errorResponse } from "./utils";

// Initialize FileStore
const fileStore = new FileStore(process.cwd());

// Initialize MCP Server
const server = new Server(
	{
		name: "knowns-mcp-server",
		version: "1.0.0",
	},
	{
		capabilities: {
			tools: {},
			resources: {},
		},
	},
);

// Combine all tool definitions
const tools: Tool[] = [
	...taskTools,
	...timeTools,
	...boardTools,
	...docTools,
	...guidelineTools,
	...templateTools,
] as Tool[];

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
	return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	try {
		switch (name) {
			// Task handlers
			case "create_task":
				return await handleCreateTask(args, fileStore);
			case "get_task":
				return await handleGetTask(args, fileStore);
			case "update_task":
				return await handleUpdateTask(args, fileStore);
			case "list_tasks":
				return await handleListTasks(args, fileStore);
			case "search_tasks":
				return await handleSearchTasks(args, fileStore);

			// Time handlers
			case "start_time":
				return await handleStartTime(args, fileStore);
			case "stop_time":
				return await handleStopTime(args, fileStore);
			case "add_time":
				return await handleAddTime(args, fileStore);
			case "get_time_report":
				return await handleGetTimeReport(args, fileStore);

			// Board handlers
			case "get_board":
				return await handleGetBoard(fileStore);

			// Doc handlers
			case "list_docs":
				return await handleListDocs(args);
			case "get_doc":
				return await handleGetDoc(args);
			case "create_doc":
				return await handleCreateDoc(args);
			case "update_doc":
				return await handleUpdateDoc(args);
			case "search_docs":
				return await handleSearchDocs(args);

			// Guideline handler
			case "get_guideline":
				return await handleGetGuideline(args);

			// Template handlers
			case "list_templates":
				return await handleListTemplates(args);
			case "get_template":
				return await handleGetTemplate(args);
			case "run_template":
				return await handleRunTemplate(args);
			case "create_template":
				return await handleCreateTemplate(args);

			default:
				return errorResponse(`Unknown tool: ${name}`);
		}
	} catch (error) {
		return errorResponse(error instanceof Error ? error.message : String(error));
	}
});

// List available resources (tasks and docs)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
	const tasks = await fileStore.getAllTasks();
	const docsDir = join(process.cwd(), ".knowns", "docs");

	// Task resources
	const taskResources = tasks.map((task) => ({
		uri: `knowns://task/${task.id}`,
		name: task.title,
		mimeType: "application/json",
		description: `Task #${task.id}: ${task.title}`,
	}));

	// Doc resources
	const docResources: Array<{
		uri: string;
		name: string;
		mimeType: string;
		description: string;
	}> = [];

	if (existsSync(docsDir)) {
		const { readdir } = await import("node:fs/promises");

		async function getAllMdFiles(dir: string, basePath = ""): Promise<string[]> {
			const files: string[] = [];
			const entries = await readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				// Use forward slashes for cross-platform consistency (Windows uses backslash)
				const relativePath = normalizePath(basePath ? join(basePath, entry.name) : entry.name);

				if (entry.isDirectory()) {
					const subFiles = await getAllMdFiles(fullPath, relativePath);
					files.push(...subFiles);
				} else if (entry.isFile() && entry.name.endsWith(".md")) {
					files.push(relativePath);
				}
			}

			return files;
		}

		const mdFiles = await getAllMdFiles(docsDir);

		for (const file of mdFiles) {
			const filepath = join(docsDir, file);
			const content = await readFile(filepath, "utf-8");
			const { data } = matter(content);

			docResources.push({
				uri: `knowns://doc/${file.replace(/\.md$/, "")}`,
				name: data.title || file.replace(/\.md$/, ""),
				mimeType: "text/markdown",
				description: data.description || `Documentation: ${file}`,
			});
		}
	}

	return {
		resources: [...taskResources, ...docResources],
	};
});

// Read resource content
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const uri = request.params.uri;

	// Handle task resources
	const taskMatch = uri.match(/^knowns:\/\/task\/(.+)$/);
	if (taskMatch) {
		const taskId = taskMatch[1];
		const task = await fileStore.getTask(taskId);

		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}

		return {
			contents: [
				{
					uri,
					mimeType: "application/json",
					text: JSON.stringify(task, null, 2),
				},
			],
		};
	}

	// Handle doc resources
	const docMatch = uri.match(/^knowns:\/\/doc\/(.+)$/);
	if (docMatch) {
		const docPath = docMatch[1];
		const docsDir = join(process.cwd(), ".knowns", "docs");
		const filepath = join(docsDir, `${docPath}.md`);

		if (!existsSync(filepath)) {
			throw new Error(`Documentation ${docPath} not found`);
		}

		const content = await readFile(filepath, "utf-8");
		const { data, content: docContent } = matter(content);

		return {
			contents: [
				{
					uri,
					mimeType: "text/markdown",
					text: JSON.stringify(
						{
							metadata: data,
							content: docContent.trim(),
						},
						null,
						2,
					),
				},
			],
		};
	}

	throw new Error(`Invalid resource URI: ${uri}`);
});

// Start the server
export async function startMcpServer(options: { verbose?: boolean } = {}) {
	if (options.verbose) {
		console.error("Knowns MCP Server starting...");
	}
	const transport = new StdioServerTransport();
	await server.connect(transport);
	if (options.verbose) {
		console.error("Knowns MCP Server running on stdio");
	}
}

// Run directly if this file is executed as the main entry point
const isStandaloneServer = process.argv[1]?.includes("mcp/server") || process.argv[1]?.includes("mcp\\server");

if (isStandaloneServer) {
	startMcpServer({ verbose: true }).catch((error) => {
		console.error("Fatal error:", error);
		process.exit(1);
	});
}
