import { afterEach, describe, expect, test } from "bun:test";
import { SIDEBAR_STORAGE_KEY, rememberedSidebarCollapsed } from "./sidebarStorage";

const store = new Map<string, string>();
const fakeStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
};

function withStorage(storage: unknown, run: () => void) {
	const had = "localStorage" in globalThis;
	const prev = (globalThis as { localStorage?: unknown }).localStorage;
	Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
	try {
		run();
	} finally {
		if (had) Object.defineProperty(globalThis, "localStorage", { value: prev, configurable: true, writable: true });
		else delete (globalThis as { localStorage?: unknown }).localStorage;
	}
}

afterEach(() => store.clear());

describe("rememberedSidebarCollapsed", () => {
	test("is false when nothing is remembered", () => {
		withStorage(fakeStorage, () => expect(rememberedSidebarCollapsed()).toBe(false));
	});

	test("reads the rail state the provider saves", () => {
		withStorage(fakeStorage, () => {
			store.set(`${SIDEBAR_STORAGE_KEY}:collapsed`, "true");
			expect(rememberedSidebarCollapsed()).toBe(true);
			store.set(`${SIDEBAR_STORAGE_KEY}:collapsed`, "false");
			expect(rememberedSidebarCollapsed()).toBe(false);
		});
	});

	test("falls back to expanded on junk or a storage that throws", () => {
		withStorage(fakeStorage, () => {
			store.set(`${SIDEBAR_STORAGE_KEY}:collapsed`, "{nope");
			expect(rememberedSidebarCollapsed()).toBe(false);
		});
		const throwing = { getItem: () => { throw new Error("blocked"); } };
		withStorage(throwing, () => expect(rememberedSidebarCollapsed()).toBe(false));
	});
});
