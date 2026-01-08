/**
 * Validation and Repair Utilities
 * Handles validation and repair of docs and tasks markdown files
 */

import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";

// Validation result interface
export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
	warnings: ValidationWarning[];
}

export interface ValidationError {
	field: string;
	message: string;
	fixable: boolean;
}

export interface ValidationWarning {
	field: string;
	message: string;
}

// Repair result interface
export interface RepairResult {
	success: boolean;
	backupPath?: string;
	fixes: string[];
	errors: string[];
}

// ==================== Doc Validation ====================

interface DocFrontmatter {
	title?: string;
	description?: string;
	createdAt?: string;
	updatedAt?: string;
	tags?: string[] | string;
}

const DOC_REQUIRED_FIELDS = ["title", "createdAt", "updatedAt"];

/**
 * Validate a doc file
 */
export function validateDoc(content: string): ValidationResult {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];

	// Try to parse frontmatter
	let data: DocFrontmatter;
	let bodyContent: string;

	try {
		const parsed = matter(content);
		data = parsed.data as DocFrontmatter;
		bodyContent = parsed.content;
	} catch (error) {
		errors.push({
			field: "frontmatter",
			message: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
			fixable: false,
		});
		return { valid: false, errors, warnings };
	}

	// Check required fields
	for (const field of DOC_REQUIRED_FIELDS) {
		if (!data[field as keyof DocFrontmatter]) {
			errors.push({
				field,
				message: `Missing required field: ${field}`,
				fixable: true,
			});
		}
	}

	// Validate title
	if (data.title && typeof data.title !== "string") {
		errors.push({
			field: "title",
			message: "Title must be a string",
			fixable: true,
		});
	}

	// Validate dates
	if (data.createdAt && !isValidISODate(data.createdAt)) {
		errors.push({
			field: "createdAt",
			message: "createdAt must be a valid ISO date",
			fixable: true,
		});
	}

	if (data.updatedAt && !isValidISODate(data.updatedAt)) {
		errors.push({
			field: "updatedAt",
			message: "updatedAt must be a valid ISO date",
			fixable: true,
		});
	}

	// Validate tags
	if (data.tags !== undefined) {
		if (typeof data.tags === "string") {
			warnings.push({
				field: "tags",
				message: "Tags should be an array, not a string",
			});
		} else if (!Array.isArray(data.tags)) {
			errors.push({
				field: "tags",
				message: "Tags must be an array of strings",
				fixable: true,
			});
		}
	}

	// Check body content
	if (!bodyContent.trim()) {
		warnings.push({
			field: "content",
			message: "Document has no content",
		});
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Repair a doc file
 */
export async function repairDoc(filePath: string): Promise<RepairResult> {
	const fixes: string[] = [];
	const repairErrors: string[] = [];

	if (!existsSync(filePath)) {
		return {
			success: false,
			errors: ["File not found"],
			fixes: [],
		};
	}

	// Create backup
	const backupPath = `${filePath}.bak`;
	try {
		await copyFile(filePath, backupPath);
	} catch (error) {
		return {
			success: false,
			errors: [`Failed to create backup: ${error instanceof Error ? error.message : String(error)}`],
			fixes: [],
		};
	}

	// Read content
	let content: string;
	try {
		content = await readFile(filePath, "utf-8");
	} catch (error) {
		return {
			success: false,
			backupPath,
			errors: [`Failed to read file: ${error instanceof Error ? error.message : String(error)}`],
			fixes: [],
		};
	}

	// Try to parse and repair
	let data: DocFrontmatter;
	let bodyContent: string;

	try {
		const parsed = matter(content);
		data = parsed.data as DocFrontmatter;
		bodyContent = parsed.content;
	} catch {
		// Try to extract what we can
		const lines = content.split("\n");
		const titleMatch = lines.find((l) => l.startsWith("# "));
		const title = titleMatch ? titleMatch.replace("# ", "").trim() : "Untitled";

		// Create new valid structure
		const now = new Date().toISOString();
		data = {
			title,
			createdAt: now,
			updatedAt: now,
		};

		// Remove any frontmatter remnants
		const frontmatterEnd = content.indexOf("---", 3);
		bodyContent =
			frontmatterEnd > 0 ? content.substring(frontmatterEnd + 3).trim() : content.replace(/^---[\s\S]*?---/, "").trim();

		fixes.push("Rebuilt corrupted frontmatter");
	}

	// Fix missing required fields
	const now = new Date().toISOString();

	if (!data.title) {
		// Try to extract from body
		const titleMatch = bodyContent.match(/^#\s+(.+)$/m);
		data.title = titleMatch ? titleMatch[1] : "Untitled Document";
		fixes.push(`Added missing title: "${data.title}"`);
	}

	if (!data.createdAt || !isValidISODate(data.createdAt)) {
		data.createdAt = now;
		fixes.push("Fixed createdAt date");
	}

	if (!data.updatedAt || !isValidISODate(data.updatedAt)) {
		data.updatedAt = now;
		fixes.push("Fixed updatedAt date");
	}

	// Fix tags if string
	if (typeof data.tags === "string") {
		data.tags = data.tags.split(",").map((t) => t.trim());
		fixes.push("Converted tags from string to array");
	}

	// Ensure tags is array or undefined
	if (data.tags && !Array.isArray(data.tags)) {
		data.tags = [];
		fixes.push("Reset invalid tags to empty array");
	}

	// Write repaired content
	try {
		const repairedContent = matter.stringify(bodyContent, data);
		await writeFile(filePath, repairedContent, "utf-8");
	} catch (error) {
		repairErrors.push(`Failed to write repaired file: ${error instanceof Error ? error.message : String(error)}`);
		return {
			success: false,
			backupPath,
			errors: repairErrors,
			fixes,
		};
	}

	return {
		success: true,
		backupPath,
		fixes,
		errors: repairErrors,
	};
}

// ==================== Task Validation ====================

interface TaskFrontmatter {
	id?: string;
	title?: string;
	status?: string;
	priority?: string;
	assignee?: string;
	labels?: string[] | string;
	parent?: string;
	createdAt?: string;
	updatedAt?: string;
	timeSpent?: number;
}

const TASK_REQUIRED_FIELDS = ["id", "title", "status", "priority", "createdAt", "updatedAt"];
const VALID_STATUSES = ["todo", "in-progress", "in-review", "done", "blocked", "on-hold"];
const VALID_PRIORITIES = ["low", "medium", "high"];

/**
 * Validate a task file
 */
export function validateTask(content: string): ValidationResult {
	const errors: ValidationError[] = [];
	const warnings: ValidationWarning[] = [];

	// Try to parse frontmatter
	let data: TaskFrontmatter;
	let bodyContent: string;

	try {
		const parsed = matter(content);
		data = parsed.data as TaskFrontmatter;
		bodyContent = parsed.content;
	} catch (error) {
		errors.push({
			field: "frontmatter",
			message: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
			fixable: false,
		});
		return { valid: false, errors, warnings };
	}

	// Check required fields
	for (const field of TASK_REQUIRED_FIELDS) {
		if (data[field as keyof TaskFrontmatter] === undefined) {
			errors.push({
				field,
				message: `Missing required field: ${field}`,
				fixable: field !== "id", // ID can't be auto-fixed
			});
		}
	}

	// Validate id format
	if (data.id && !/^\d+(\.\d+)*$/.test(data.id)) {
		errors.push({
			field: "id",
			message: "Invalid ID format (expected: number or hierarchical like 7.1.2)",
			fixable: false,
		});
	}

	// Validate status
	if (data.status && !VALID_STATUSES.includes(data.status)) {
		errors.push({
			field: "status",
			message: `Invalid status: ${data.status}. Expected one of: ${VALID_STATUSES.join(", ")}`,
			fixable: true,
		});
	}

	// Validate priority
	if (data.priority && !VALID_PRIORITIES.includes(data.priority)) {
		errors.push({
			field: "priority",
			message: `Invalid priority: ${data.priority}. Expected one of: ${VALID_PRIORITIES.join(", ")}`,
			fixable: true,
		});
	}

	// Validate dates
	if (data.createdAt && !isValidISODate(data.createdAt)) {
		errors.push({
			field: "createdAt",
			message: "createdAt must be a valid ISO date",
			fixable: true,
		});
	}

	if (data.updatedAt && !isValidISODate(data.updatedAt)) {
		errors.push({
			field: "updatedAt",
			message: "updatedAt must be a valid ISO date",
			fixable: true,
		});
	}

	// Validate labels
	if (data.labels !== undefined) {
		if (typeof data.labels === "string") {
			warnings.push({
				field: "labels",
				message: "Labels should be an array, not a string",
			});
		} else if (!Array.isArray(data.labels)) {
			errors.push({
				field: "labels",
				message: "Labels must be an array of strings",
				fixable: true,
			});
		}
	}

	// Validate timeSpent
	if (data.timeSpent !== undefined && (typeof data.timeSpent !== "number" || data.timeSpent < 0)) {
		errors.push({
			field: "timeSpent",
			message: "timeSpent must be a non-negative number",
			fixable: true,
		});
	}

	// Check body structure
	if (!bodyContent.includes("# ")) {
		warnings.push({
			field: "content",
			message: "Missing title heading in body",
		});
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Repair a task file
 */
export async function repairTask(filePath: string, extractedId?: string): Promise<RepairResult> {
	const fixes: string[] = [];
	const repairErrors: string[] = [];

	if (!existsSync(filePath)) {
		return {
			success: false,
			errors: ["File not found"],
			fixes: [],
		};
	}

	// Create backup
	const backupPath = `${filePath}.bak`;
	try {
		await copyFile(filePath, backupPath);
	} catch (error) {
		return {
			success: false,
			errors: [`Failed to create backup: ${error instanceof Error ? error.message : String(error)}`],
			fixes: [],
		};
	}

	// Read content
	let content: string;
	try {
		content = await readFile(filePath, "utf-8");
	} catch (error) {
		return {
			success: false,
			backupPath,
			errors: [`Failed to read file: ${error instanceof Error ? error.message : String(error)}`],
			fixes: [],
		};
	}

	// Try to parse and repair
	let data: TaskFrontmatter;
	let bodyContent: string;

	try {
		const parsed = matter(content);
		data = parsed.data as TaskFrontmatter;
		bodyContent = parsed.content;
	} catch {
		// Extract what we can from filename or content
		const titleMatch = content.match(/^#\s+(.+)$/m);
		const title = titleMatch ? titleMatch[1] : "Untitled Task";

		const now = new Date().toISOString();
		data = {
			id: extractedId,
			title,
			status: "todo",
			priority: "medium",
			labels: [],
			createdAt: now,
			updatedAt: now,
			timeSpent: 0,
		};

		// Clean body content
		const frontmatterEnd = content.indexOf("---", 3);
		bodyContent =
			frontmatterEnd > 0 ? content.substring(frontmatterEnd + 3).trim() : content.replace(/^---[\s\S]*?---/, "").trim();

		fixes.push("Rebuilt corrupted frontmatter");
	}

	const now = new Date().toISOString();

	// Fix ID if provided
	if (!data.id && extractedId) {
		data.id = extractedId;
		fixes.push(`Set ID from filename: ${extractedId}`);
	}

	// Fix missing title
	if (!data.title) {
		const titleMatch = bodyContent.match(/^#\s+(.+)$/m);
		data.title = titleMatch ? titleMatch[1] : "Untitled Task";
		fixes.push(`Added missing title: "${data.title}"`);
	}

	// Fix status
	if (!data.status || !VALID_STATUSES.includes(data.status)) {
		data.status = "todo";
		fixes.push("Set status to 'todo'");
	}

	// Fix priority
	if (!data.priority || !VALID_PRIORITIES.includes(data.priority)) {
		data.priority = "medium";
		fixes.push("Set priority to 'medium'");
	}

	// Fix dates
	if (!data.createdAt || !isValidISODate(data.createdAt)) {
		data.createdAt = now;
		fixes.push("Fixed createdAt date");
	}

	if (!data.updatedAt || !isValidISODate(data.updatedAt)) {
		data.updatedAt = now;
		fixes.push("Fixed updatedAt date");
	}

	// Fix labels
	if (typeof data.labels === "string") {
		data.labels = data.labels.split(",").map((l) => l.trim());
		fixes.push("Converted labels from string to array");
	}
	if (!Array.isArray(data.labels)) {
		data.labels = [];
		fixes.push("Reset invalid labels to empty array");
	}

	// Fix timeSpent
	if (typeof data.timeSpent !== "number" || data.timeSpent < 0) {
		data.timeSpent = 0;
		fixes.push("Reset timeSpent to 0");
	}

	// Ensure body has title heading
	if (!bodyContent.includes("# ") && data.title) {
		bodyContent = `# ${data.title}\n\n${bodyContent}`;
		fixes.push("Added title heading to body");
	}

	// Write repaired content
	try {
		const repairedContent = matter.stringify(bodyContent, data);
		await writeFile(filePath, repairedContent, "utf-8");
	} catch (error) {
		repairErrors.push(`Failed to write repaired file: ${error instanceof Error ? error.message : String(error)}`);
		return {
			success: false,
			backupPath,
			errors: repairErrors,
			fixes,
		};
	}

	return {
		success: true,
		backupPath,
		fixes,
		errors: repairErrors,
	};
}

// ==================== Helpers ====================

/**
 * Check if string is valid ISO date
 */
function isValidISODate(dateString: string): boolean {
	if (typeof dateString !== "string") return false;
	const date = new Date(dateString);
	return !Number.isNaN(date.getTime());
}

/**
 * Extract task ID from filename
 * Supports sequential numeric IDs and new base36 IDs
 * e.g., "task-7 - Some Title.md" -> "7"
 * e.g., "task-7.1 - Some Title.md" -> "7.1"
 * e.g., "task-a7f3k9 - Some Title.md" -> "a7f3k9"
 */
export function extractTaskIdFromFilename(filename: string): string | undefined {
	const match = filename.match(/^task-([a-z0-9]+(?:\.[a-z0-9]+)?)\s*-/i);
	return match ? match[1] : undefined;
}
