import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ToastOptions } from "@/ui/components/ui/knowns/toast";
import { registerToastHost, toast } from "./sonner";

function fakeHost() {
	const shown: (ToastOptions & { hostId: number })[] = [];
	const dismissed: number[] = [];
	let next = 0;
	return {
		shown,
		dismissed,
		host: {
			show: (t: ToastOptions) => {
				shown.push({ ...t, hostId: ++next });
				return next;
			},
			dismiss: (id: number) => dismissed.push(id),
		},
	};
}

let unregister: (() => void) | null = null;
afterEach(() => {
	toast.dismiss();
	unregister?.();
	unregister = null;
});

describe("toast bridge", () => {
	test("maps sonner calls to Knowns UI tones and keeps description and action", () => {
		const f = fakeHost();
		unregister = registerToastHost(f.host);
		const onClick = () => {};
		toast("Back online", { description: "d", action: { label: "Reload", onClick }, position: "top-center" });
		toast.success("Saved", { duration: 1500 });
		toast.error("Failed");
		expect(f.shown.map((t) => [t.title, t.tone])).toEqual([
			["Back online", "neutral"],
			["Saved", "success"],
			["Failed", "danger"],
		]);
		expect(f.shown[0]!.description).toBe("d");
		expect(f.shown[0]!.action?.label).toBe("Reload");
		expect(f.shown[1]!.duration).toBe(1500);
		expect(f.shown[2]!.duration).toBeUndefined();
	});

	test("dismisses a toast by the id it returned", () => {
		const f = fakeHost();
		unregister = registerToastHost(f.host);
		toast("first");
		const id = toast("second");
		toast.dismiss(id);
		expect(f.dismissed).toEqual([2]);
	});

	test("queues calls made before the host mounts and drops dismissed ones", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const kept = toast.success("kept");
		const dropped = toast("dropped");
		toast.dismiss(dropped);
		expect(warn).toHaveBeenCalledTimes(1);
		const f = fakeHost();
		unregister = registerToastHost(f.host);
		expect(f.shown.map((t) => t.title)).toEqual(["kept"]);
		toast.dismiss(kept);
		expect(f.dismissed).toEqual([1]);
		warn.mockRestore();
	});

	test("keeps a toast with an infinite duration within the timer range", () => {
		const f = fakeHost();
		unregister = registerToastHost(f.host);
		toast("offline", { duration: Infinity });
		expect(f.shown[0]!.duration).toBe(2_147_483_647);
	});

	test("a reused id replaces the earlier toast", () => {
		const f = fakeHost();
		unregister = registerToastHost(f.host);
		toast("one", { id: "sse" });
		toast("two", { id: "sse" });
		expect(f.dismissed).toEqual([1]);
		expect(f.shown.map((t) => t.title)).toEqual(["one", "two"]);
	});
});
