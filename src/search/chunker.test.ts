/**
 * Chunker Tests
 * Test document and task chunking logic
 */

import { describe, expect, it } from "vitest";
import type { Task } from "../models/task";
import { chunkDocument, chunkTask, estimateTokens, extractHeadings, getTaskSearchableContent } from "./chunker";
import type { DocChunk, TaskChunk } from "./types";

describe("estimateTokens", () => {
	it("should return 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("should estimate tokens based on character count", () => {
		// 4 chars per token estimate
		expect(estimateTokens("test")).toBe(1);
		expect(estimateTokens("12345678")).toBe(2);
		expect(estimateTokens("a".repeat(100))).toBe(25);
	});
});

describe("extractHeadings", () => {
	it("should extract headings with content", () => {
		const markdown = `# Title

Some intro text.

## Section 1

Content for section 1.

## Section 2

Content for section 2.

### Subsection 2.1

More content here.
`;

		const headings = extractHeadings(markdown);

		expect(headings).toHaveLength(4);
		expect(headings[0].level).toBe(1);
		expect(headings[0].title).toBe("Title");
		expect(headings[1].level).toBe(2);
		expect(headings[1].title).toBe("Section 1");
		expect(headings[2].level).toBe(2);
		expect(headings[2].title).toBe("Section 2");
		expect(headings[3].level).toBe(3);
		expect(headings[3].title).toBe("Subsection 2.1");
	});

	it("should handle markdown without headings", () => {
		const markdown = "Just some plain text without any headings.";
		const headings = extractHeadings(markdown);
		expect(headings).toHaveLength(0);
	});

	it("should handle empty content", () => {
		expect(extractHeadings("")).toHaveLength(0);
	});
});

describe("chunkDocument", () => {
	it("should create metadata chunk first", () => {
		const content = "## Overview\n\nSome content here.";
		const metadata = {
			path: "guides/test",
			title: "Test Guide",
			description: "A test guide for testing",
		};

		const result = chunkDocument(content, metadata);
		const firstChunk = result.chunks[0] as DocChunk;

		expect(firstChunk.id).toBe("doc:guides/test:chunk:0");
		expect(firstChunk.section).toBe("# Metadata");
		expect(firstChunk.content).toContain("Test Guide");
		expect(firstChunk.content).toContain("A test guide for testing");
	});

	it("should chunk by headings", () => {
		const content = `## Overview

This is the overview section.

## Installation

Steps to install.

## Usage

How to use it.
`;
		const metadata = { path: "readme", title: "README" };

		const result = chunkDocument(content, metadata);
		const docChunks = result.chunks as DocChunk[];

		// Metadata + 3 sections
		expect(docChunks.length).toBeGreaterThanOrEqual(4);
		expect(docChunks[1].section).toBe("## Overview");
		expect(docChunks[2].section).toBe("## Installation");
		expect(docChunks[3].section).toBe("## Usage");
	});

	it("should track parent section for nested headings", () => {
		const content = `## Parent Section

Some content.

### Child Section

Child content.
`;
		const metadata = { path: "test", title: "Test" };

		const result = chunkDocument(content, metadata);
		const docChunks = result.chunks as DocChunk[];

		const childChunk = docChunks.find((c) => c.section === "### Child Section");
		expect(childChunk?.metadata.parentSection).toBe("## Parent Section");
	});

	it("should handle document without headings", () => {
		const content = "Just plain text without any headings.";
		const metadata = { path: "plain", title: "Plain Doc" };

		const result = chunkDocument(content, metadata);

		// Should have metadata chunk + content chunk
		expect(result.chunks.length).toBe(2);
	});

	it("should set correct chunk IDs", () => {
		const content = "## Section\n\nContent";
		const metadata = { path: "api/endpoints", title: "API" };

		const result = chunkDocument(content, metadata);

		expect(result.chunks[0].id).toBe("doc:api/endpoints:chunk:0");
		expect(result.chunks[1].id).toBe("doc:api/endpoints:chunk:1");
	});
});

describe("chunkTask", () => {
	const createMockTask = (overrides: Partial<Task> = {}): Task => ({
		id: "abc123",
		title: "Test Task",
		description: "This is a test task description",
		status: "in-progress",
		priority: "high",
		labels: ["test", "feature"],
		subtasks: [],
		acceptanceCriteria: [
			{ text: "Criterion 1", completed: false },
			{ text: "Criterion 2", completed: true },
		],
		timeSpent: 0,
		timeEntries: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	});

	it("should create chunk for description", () => {
		const task = createMockTask();
		const result = chunkTask(task);
		const taskChunks = result.chunks as TaskChunk[];

		const descChunk = taskChunks.find((c) => c.field === "description");
		expect(descChunk).toBeDefined();
		expect(descChunk?.content).toContain("Test Task");
		expect(descChunk?.content).toContain("test task description");
	});

	it("should create chunk for acceptance criteria", () => {
		const task = createMockTask();
		const result = chunkTask(task);
		const taskChunks = result.chunks as TaskChunk[];

		const acChunk = taskChunks.find((c) => c.field === "ac");
		expect(acChunk).toBeDefined();
		expect(acChunk?.content).toContain("Criterion 1");
		expect(acChunk?.content).toContain("Criterion 2");
	});

	it("should create chunk for implementation plan if present", () => {
		const task = createMockTask({
			implementationPlan: "1. Step one\n2. Step two",
		});
		const result = chunkTask(task);
		const taskChunks = result.chunks as TaskChunk[];

		const planChunk = taskChunks.find((c) => c.field === "plan");
		expect(planChunk).toBeDefined();
		expect(planChunk?.content).toContain("Step one");
	});

	it("should create chunk for implementation notes if present", () => {
		const task = createMockTask({
			implementationNotes: "Done: Implemented feature X",
		});
		const result = chunkTask(task);
		const taskChunks = result.chunks as TaskChunk[];

		const notesChunk = taskChunks.find((c) => c.field === "notes");
		expect(notesChunk).toBeDefined();
		expect(notesChunk?.content).toContain("Implemented feature X");
	});

	it("should skip empty fields", () => {
		const task = createMockTask({
			acceptanceCriteria: [],
			implementationPlan: undefined,
			implementationNotes: undefined,
		});
		const result = chunkTask(task);
		const taskChunks = result.chunks as TaskChunk[];

		// Only description should be present
		expect(taskChunks).toHaveLength(1);
		expect(taskChunks[0].field).toBe("description");
	});

	it("should include metadata in each chunk", () => {
		const task = createMockTask();
		const result = chunkTask(task);
		const taskChunks = result.chunks as TaskChunk[];

		for (const chunk of taskChunks) {
			expect(chunk.metadata.status).toBe("in-progress");
			expect(chunk.metadata.priority).toBe("high");
			expect(chunk.metadata.labels).toEqual(["test", "feature"]);
		}
	});

	it("should set correct chunk IDs", () => {
		const task = createMockTask({ id: "xyz789" });
		const result = chunkTask(task);
		const taskChunks = result.chunks as TaskChunk[];

		const descChunk = taskChunks.find((c) => c.field === "description");
		expect(descChunk?.id).toBe("task:xyz789:chunk:description");
	});
});

describe("getTaskSearchableContent", () => {
	it("should combine all task fields", () => {
		const task: Task = {
			id: "123",
			title: "My Task",
			description: "Task description",
			status: "todo",
			priority: "medium",
			labels: [],
			subtasks: [],
			acceptanceCriteria: [{ text: "AC text", completed: false }],
			implementationPlan: "The plan",
			implementationNotes: "The notes",
			timeSpent: 0,
			timeEntries: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const content = getTaskSearchableContent(task);

		expect(content).toContain("My Task");
		expect(content).toContain("Task description");
		expect(content).toContain("AC text");
		expect(content).toContain("The plan");
		expect(content).toContain("The notes");
	});

	it("should handle minimal task", () => {
		const task: Task = {
			id: "123",
			title: "Minimal Task",
			status: "todo",
			priority: "low",
			labels: [],
			subtasks: [],
			acceptanceCriteria: [],
			timeSpent: 0,
			timeEntries: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const content = getTaskSearchableContent(task);
		expect(content).toBe("Minimal Task");
	});
});
