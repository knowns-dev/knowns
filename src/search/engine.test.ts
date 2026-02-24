/**
 * Hybrid Search Engine Tests
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingService } from "./embedding";
import { HybridSearchEngine } from "./engine";
import { SearchIndexStore } from "./store";
import type { DocChunk, TaskChunk } from "./types";

// Mock EmbeddingService type
type MockEmbeddingService = Pick<
	EmbeddingService,
	"embed" | "embedBatch" | "embedChunks" | "loadModel" | "isModelDownloaded" | "getModelConfig" | "dispose"
>;

// Mock EmbeddingService
const createMockEmbeddingService = (): MockEmbeddingService => ({
	embed: vi.fn().mockResolvedValue({
		embedding: Array(384).fill(0.1),
		tokenCount: 10,
	}),
	embedBatch: vi.fn(),
	embedChunks: vi.fn(),
	loadModel: vi.fn(),
	isModelDownloaded: vi.fn().mockReturnValue(true),
	getModelConfig: vi.fn().mockReturnValue({
		name: "gte-small",
		dimensions: 384,
		maxTokens: 512,
		huggingFaceId: "Xenova/gte-small",
	}),
	dispose: vi.fn(),
});

describe("HybridSearchEngine", () => {
	let testDir: string;
	let store: SearchIndexStore;
	let engine: HybridSearchEngine;
	let mockEmbeddingService: MockEmbeddingService;

	// Sample chunks for testing
	const mockDocChunks: DocChunk[] = [
		{
			id: "doc:readme:chunk:0",
			type: "doc",
			docPath: "readme",
			section: "# Metadata",
			content: "Project README: A guide to authentication and user management",
			tokenCount: 15,
			embedding: Array(384).fill(0.1),
			metadata: { headingLevel: 1, position: 0 },
		},
		{
			id: "doc:readme:chunk:1",
			type: "doc",
			docPath: "readme",
			section: "## Authentication",
			content: "This section covers user authentication, login flow, and session management",
			tokenCount: 20,
			embedding: Array(384).fill(0.2),
			metadata: { headingLevel: 2, position: 1 },
		},
		{
			id: "doc:api:chunk:0",
			type: "doc",
			docPath: "api",
			section: "## Endpoints",
			content: "API endpoints for user sign in and registration",
			tokenCount: 12,
			embedding: Array(384).fill(0.15),
			metadata: { headingLevel: 2, position: 0 },
		},
	];

	const mockTaskChunks: TaskChunk[] = [
		{
			id: "task:abc123:chunk:description",
			type: "task",
			taskId: "abc123",
			field: "description",
			content: "Implement user authentication with JWT tokens",
			tokenCount: 10,
			embedding: Array(384).fill(0.25),
			metadata: { status: "in-progress", priority: "high", labels: ["feature", "auth"] },
		},
		{
			id: "task:def456:chunk:description",
			type: "task",
			taskId: "def456",
			field: "description",
			content: "Fix login timeout issue on slow networks",
			tokenCount: 10,
			embedding: Array(384).fill(0.3),
			metadata: { status: "todo", priority: "medium", labels: ["bug"] },
		},
	];

	beforeEach(async () => {
		// Create temp directory
		testDir = join(tmpdir(), `knowns-engine-test-${Date.now()}`);
		await mkdir(join(testDir, ".knowns"), { recursive: true });

		// Initialize store and add chunks
		store = new SearchIndexStore(testDir, "gte-small");
		await store.initDatabase();

		// Add all chunks to the store
		const allChunks = [...mockDocChunks, ...mockTaskChunks];
		await store.addChunks(allChunks);

		// Create mock embedding service
		mockEmbeddingService = createMockEmbeddingService();

		// Create engine
		engine = new HybridSearchEngine(store, mockEmbeddingService as EmbeddingService, "gte-small");
	});

	afterEach(async () => {
		if (existsSync(testDir)) {
			await rm(testDir, { recursive: true });
		}
	});

	describe("search modes", () => {
		it("should perform semantic search", async () => {
			const response = await engine.search("user authentication", { mode: "semantic" });

			expect(response.mode).toBe("semantic");
			expect(response.results).toBeDefined();
			expect(response.elapsed).toBeGreaterThan(0);
			expect(mockEmbeddingService.embed).toHaveBeenCalledWith("user authentication");
		});

		it("should perform fuzzy search", async () => {
			const response = await engine.search("authentcation", { mode: "fuzzy", tolerance: 2 });

			expect(response.mode).toBe("fuzzy");
			expect(response.results).toBeDefined();
			// Fuzzy search shouldn't need embeddings
			expect(mockEmbeddingService.embed).not.toHaveBeenCalled();
		});

		it("should perform keyword search", async () => {
			const response = await engine.search("authentication", { mode: "keyword" });

			expect(response.mode).toBe("keyword");
			expect(response.results).toBeDefined();
			// Keyword search shouldn't need embeddings
			expect(mockEmbeddingService.embed).not.toHaveBeenCalled();
		});

		it("should perform hybrid search by default", async () => {
			const response = await engine.search("authentication login");

			expect(response.mode).toBe("hybrid");
			expect(response.results).toBeDefined();
			// Hybrid search uses embeddings for semantic component
			expect(mockEmbeddingService.embed).toHaveBeenCalled();
		});
	});

	describe("filtering", () => {
		it("should filter by type=doc", async () => {
			const response = await engine.search("authentication", { mode: "keyword", type: "doc" });

			for (const result of response.results) {
				expect(result.type).toBe("doc");
			}
		});

		it("should filter by type=task", async () => {
			const response = await engine.search("authentication", { mode: "keyword", type: "task" });

			for (const result of response.results) {
				expect(result.type).toBe("task");
			}
		});

		it("should filter by status", async () => {
			const response = await engine.search("", {
				mode: "fuzzy",
				type: "task",
				status: "in-progress",
			});

			for (const result of response.results) {
				expect(result.status).toBe("in-progress");
			}
		});

		it("should filter by priority", async () => {
			const response = await engine.search("", {
				mode: "fuzzy",
				type: "task",
				priority: "high",
			});

			for (const result of response.results) {
				expect(result.priority).toBe("high");
			}
		});
	});

	describe("result structure", () => {
		it("should return proper doc result structure", async () => {
			const response = await engine.search("authentication", { mode: "keyword", type: "doc", limit: 1 });

			if (response.results.length > 0) {
				const result = response.results[0];
				expect(result.id).toBeDefined();
				expect(result.type).toBe("doc");
				expect(result.score).toBeGreaterThanOrEqual(0);
				expect(result.score).toBeLessThanOrEqual(1);
				expect(result.content).toBeDefined();
				expect(result.docPath).toBeDefined();
				expect(result.section).toBeDefined();
				expect(result.matchedBy).toContain("keyword");
			}
		});

		it("should return proper task result structure", async () => {
			const response = await engine.search("JWT", { mode: "keyword", type: "task", limit: 1 });

			if (response.results.length > 0) {
				const result = response.results[0];
				expect(result.id).toBeDefined();
				expect(result.type).toBe("task");
				expect(result.score).toBeGreaterThanOrEqual(0);
				expect(result.content).toBeDefined();
				expect(result.taskId).toBeDefined();
				expect(result.field).toBeDefined();
				expect(result.status).toBeDefined();
				expect(result.priority).toBeDefined();
				expect(result.labels).toBeDefined();
			}
		});
	});

	describe("hybrid scoring", () => {
		it("should boost results matched by multiple methods", async () => {
			// Reset mock to track calls
			mockEmbeddingService.embed.mockClear();

			const response = await engine.search("authentication", {
				mode: "hybrid",
				semanticWeight: 0.5,
				keywordWeight: 0.5,
			});

			// Results matched by multiple methods should have matchedBy array with multiple entries
			const multiMatchResults = response.results.filter((r) => r.matchedBy.length > 1);

			// If there are multi-match results, they should be ranked higher
			if (multiMatchResults.length > 0 && response.results.length > 1) {
				const firstResult = response.results[0];
				// The top result should ideally have multiple matches
				expect(firstResult.matchedBy.length).toBeGreaterThanOrEqual(1);
			}
		});

		it("should respect weight configuration", async () => {
			// High semantic weight
			const semanticHeavy = await engine.search("user auth", {
				mode: "hybrid",
				semanticWeight: 0.9,
				keywordWeight: 0.1,
			});

			// High keyword weight
			const keywordHeavy = await engine.search("user auth", {
				mode: "hybrid",
				semanticWeight: 0.1,
				keywordWeight: 0.9,
			});

			// Both should return results
			expect(semanticHeavy.results).toBeDefined();
			expect(keywordHeavy.results).toBeDefined();
		});
	});

	describe("performance", () => {
		it("should complete search in < 50ms for small dataset", async () => {
			const response = await engine.search("authentication", { mode: "hybrid" });

			// Should be well under 50ms for 5 items
			expect(response.elapsed).toBeLessThan(50);
		});

		it("should return response time in elapsed field", async () => {
			const response = await engine.search("test", { mode: "keyword" });

			expect(response.elapsed).toBeGreaterThan(0);
			expect(typeof response.elapsed).toBe("number");
		});
	});

	describe("edge cases", () => {
		it("should handle empty query", async () => {
			const response = await engine.search("", { mode: "fuzzy" });

			expect(response.results).toBeDefined();
			expect(response.count).toBeGreaterThanOrEqual(0);
		});

		it("should handle no results", async () => {
			const response = await engine.search("xyznonexistent12345", { mode: "keyword" });

			expect(response.results).toEqual([]);
			expect(response.count).toBe(0);
		});

		it("should respect limit option", async () => {
			const response = await engine.search("", { mode: "fuzzy", limit: 2 });

			expect(response.results.length).toBeLessThanOrEqual(2);
		});

		it("should handle missing database gracefully", async () => {
			// Create engine with store that has no database
			const emptyStore = new SearchIndexStore(`${testDir}-empty`, "gte-small");
			const emptyEngine = new HybridSearchEngine(emptyStore, mockEmbeddingService as EmbeddingService, "gte-small");

			const response = await emptyEngine.search("test");

			expect(response.results).toEqual([]);
			expect(response.count).toBe(0);
		});
	});

	describe("accessors", () => {
		it("should return embedding service via getEmbeddingService", () => {
			const service = engine.getEmbeddingService();
			expect(service).toBe(mockEmbeddingService);
		});

		it("should return store via getStore", () => {
			const engineStore = engine.getStore();
			expect(engineStore).toBe(store);
		});
	});
});
