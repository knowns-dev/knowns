import { useEffect, useState } from "react";

import type { KnowledgeSemanticEdgeKind } from "./constants";

/**
 * Colours for graph entities and relations, one set per theme. The canvas is drawn with WebGL,
 * which cannot read CSS variables, so the values are concrete. The light set is a step darker so
 * small nodes keep their contrast on white; the dark set is a step lighter for the same reason.
 * The surface colours (canvas, labels, outlines) come from the app tokens instead, see
 * `readCanvasPalette`.
 */
export interface GraphColors {
	task: string;
	doc: string;
	memory: string;
	decision: string;
	template: string;
	code: string;
	memoryLayers: Record<"working" | "project" | "global", string>;
	/** Parent and mention lines, and anything without its own colour. */
	neutral: string;
	edges: Record<KnowledgeSemanticEdgeKind, string>;
}

const LIGHT: GraphColors = {
	task: "#4f46e5",
	doc: "#d97706",
	memory: "#059669",
	decision: "#e11d48",
	template: "#0891b2",
	code: "#db2777",
	memoryLayers: { working: "#71717a", project: "#059669", global: "#7c3aed" },
	neutral: "#a1a1aa",
	edges: {
		references: "#71717a",
		implements: "#4f46e5",
		"blocked-by": "#dc2626",
		related: "#7c3aed",
		depends: "#0284c7",
		follows: "#059669",
	},
};

const DARK: GraphColors = {
	task: "#818cf8",
	doc: "#fbbf24",
	memory: "#34d399",
	decision: "#fb7185",
	template: "#22d3ee",
	code: "#f472b6",
	memoryLayers: { working: "#a1a1aa", project: "#34d399", global: "#a78bfa" },
	neutral: "#71717a",
	edges: {
		references: "#a1a1aa",
		implements: "#818cf8",
		"blocked-by": "#f87171",
		related: "#a78bfa",
		depends: "#38bdf8",
		follows: "#34d399",
	},
};

export interface ConstellationPalette {
	canvas: string;
	labelSurface: string;
	labelBorder: string;
	text: string;
	nodeOutline: string;
	dimNode: string;
	link: string;
	dimLink: string;
	colors: GraphColors;
}

let probe: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour (hsl, oklch, a named colour) as #rrggbb, which sigma and `withAlpha` understand. */
function toHex(value: string, fallback: string): string {
	if (!value) return fallback;
	if (probe === undefined) {
		try {
			probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		} catch {
			probe = null;
		}
	}
	if (!probe) return fallback;
	probe.clearRect(0, 0, 1, 1);
	probe.fillStyle = fallback;
	probe.fillStyle = value;
	probe.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
	return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: string, b: string, weight: number): string {
	const channel = (hex: string, index: number) => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
	const out = [0, 1, 2].map((index) => Math.round(channel(a, index) * weight + channel(b, index) * (1 - weight)));
	return `#${out.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function readCanvasPalette(dark: boolean): ConstellationPalette {
	const styles = getComputedStyle(document.documentElement);
	const token = (name: string, fallback: string) => toHex(styles.getPropertyValue(name).trim(), fallback);
	const canvas = token("--background", dark ? "#09090b" : "#ffffff");
	const text = token("--foreground", dark ? "#fafafa" : "#09090b");
	const border = token("--border", dark ? "#27272a" : "#e4e4e7");
	const muted = token("--muted-foreground", dark ? "#a1a1aa" : "#71717a");
	return {
		canvas,
		labelSurface: token("--card", canvas),
		labelBorder: border,
		text,
		nodeOutline: canvas,
		dimNode: muted,
		// Lines sit between the border and the muted text, so they read without competing with nodes.
		link: mix(muted, border, dark ? 0.45 : 0.35),
		dimLink: mix(border, canvas, 0.6),
		colors: dark ? DARK : LIGHT,
	};
}

const isDarkNow = () => typeof document !== "undefined" && document.documentElement.classList.contains("dark");

/**
 * The graph palette for the theme that is on screen. Watches the `dark` class on <html> rather
 * than the theme context, so the colours are read after the new tokens apply.
 */
export function useGraphTheme(): ConstellationPalette {
	const [palette, setPalette] = useState(() => readCanvasPalette(isDarkNow()));
	useEffect(() => {
		let dark = isDarkNow();
		const observer = new MutationObserver(() => {
			const next = isDarkNow();
			if (next === dark) return;
			dark = next;
			setPalette(readCanvasPalette(next));
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		// The tokens may have changed between the first render and this effect.
		setPalette(readCanvasPalette(dark));
		return () => observer.disconnect();
	}, []);
	return palette;
}
