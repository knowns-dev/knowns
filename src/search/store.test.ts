/**
 * Search Index Store Tests
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchIndexStore } from "./store";
import type { DocChunk, TaskChunk } from "./types";

describe("SearchIndexStore", () => {
	let testDir: string;
	let store: SearchIndexStore;

	beforeEach(async () => {
		// Create temp directory for tests
		testDir = join(tmpdir(), `knowns-test-${Date.now()}`);
		await mkdir(join(testDir, ".knowns"), { recursive: true });
		store = new SearchIndexStore(testDir, "gte-small");
	});

	afterEach(async () => {
		// Cleanup
		if (existsSync(testDir)) {
			await rm(testDir, { recursive: true });
		}
	});

	describe("indexExists", () => {
		it("should return false when index does not exist", () => {
			expect(store.indexExists()).toBe(false);
		});
	});

	describe("getVersion", () => {
		it("should return null when version file does not exist", async () => {
			const version = await store.getVersion();
			expect(version).toBeNull();
		});
	});

	describe("needsRebuild", () => {
		it("should return true when index does not exist", async () => {
			const needsRebuild = await store.needsRebuild();
			expect(needsRebuild).toBe(true);
		});
	});

	describe("initDatabase", () => {
		it("should create Orama database instance", async () => {
			const db = await store.initDatabase();
			expect(db).toBeDefined();
		});
	});

	describe("save and load", () => {
		const mockDocChunk: DocChunk = {
			id: "doc:readme:chunk:0",
			type: "doc",
			docPath: "readme",
			section: "## Overview",
			content: "This is the overview section.",
			tokenCount: 10,
			embedding: Array(384).fill(0.1),
			metadata: {
				headingLevel: 2,
				position: 0,
			},
		};

		const mockTaskChunk: TaskChunk = {
			id: "task:abc123:chunk:description",
			type: "task",
			taskId: "abc123",
			field: "description",
			content: "Implement feature X",
			tokenCount: 5,
			embedding: Array(384).fill(0.2),
			metadata: {
				status: "in-progress",
				priority: "high",
				labels: ["feature"],
			},
		};

		it("should save chunks to disk", async () => {
			await store.save([mockDocChunk, mockTaskChunk]);

			const indexPath = join(testDir, ".knowns", "search-index");
			expect(existsSync(join(indexPath, "version.json"))).toBe(true);
			expect(existsSync(join(indexPath, "index.json"))).toBe(true);
			expect(existsSync(join(indexPath, "embeddings.bin"))).toBe(true);
		});

		it("should save correct version info", async () => {
			await store.save([mockDocChunk, mockTaskChunk]);

			const version = await store.getVersion();
			expect(version).not.toBeNull();
			expect(version?.model).toBe("gte-small");
			expect(version?.dimensions).toBe(384);
			expect(version?.chunkCount).toBe(2);
			expect(version?.itemCount).toBe(2); // 1 doc + 1 task
		});

		it("should load chunks from disk", async () => {
			// Save first
			await store.save([mockDocChunk, mockTaskChunk]);

			// Create new store instance
			const newStore = new SearchIndexStore(testDir, "gte-small");

			// Load should succeed
			await newStore.load();

			// Database should be populated
			const db = newStore.getDb();
			expect(db).not.toBeNull();
		});

		it("should throw when loading with different model", async () => {
			// Save with gte-small
			await store.save([mockDocChunk]);

			// Try to load with different model
			const newStore = new SearchIndexStore(testDir, "gte-base");

			await expect(newStore.load()).rejects.toThrow("Index needs rebuild");
		});
	});

	describe("clear", () => {
		it("should remove all index files", async () => {
			const mockChunk: DocChunk = {
				id: "doc:test:chunk:0",
				type: "doc",
				docPath: "test",
				section: "## Test",
				content: "Test content",
				tokenCount: 5,
				embedding: Array(384).fill(0.1),
				metadata: {
					headingLevel: 2,
					position: 0,
				},
			};

			await store.save([mockChunk]);
			expect(store.indexExists()).toBe(true);

			await store.clear();
			expect(store.indexExists()).toBe(false);
		});
	});
});
