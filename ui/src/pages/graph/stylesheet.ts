import type cytoscape from "cytoscape";

export function buildStylesheet(isDark: boolean): cytoscape.StylesheetStyle[] {
	const labelColor = isDark ? "#d1d5db" : "#374151";
	const dimEdge = isDark ? "#4b5563" : "#d1d5db";

	return [
		{
			selector: "node",
			style: {
				label: "",
				"text-valign": "bottom",
				"text-halign": "center",
				"font-size": "11px",
				color: labelColor,
				"text-margin-y": 4,
				"text-max-width": "100px",
				"text-wrap": "ellipsis",
				"background-color": "data(color)",
				"border-color": "data(borderColor)",
				"border-width": 2,
				"overlay-opacity": 0,
				"transition-property": "none",
				"transition-duration": 0,
			} as any,
		},
		{
			selector: "node.show-label",
			style: {
				label: "data(label)",
			} as any,
		},
		{
			selector: 'node[nodeType="task"]',
			style: {
				shape: "ellipse",
				width: 28,
				height: 28,
			} as any,
		},
		{
			selector: 'node[nodeType="doc"]',
			style: {
				shape: "ellipse",
				width: 26,
				height: 26,
			} as any,
		},
		{
			selector: 'node[nodeType="memory"]',
			style: {
				shape: "ellipse",
				width: 24,
				height: 24,
			} as any,
		},
		{
			selector: 'node[nodeType="decision"]',
			style: {
				shape: "diamond",
				width: 26,
				height: 26,
			} as any,
		},
		{
			selector: 'node[nodeType="template"]',
			style: {
				shape: "round-rectangle",
				width: 26,
				height: 24,
			} as any,
		},
		{
			selector: 'node[nodeType="code"]',
			style: {
				shape: "ellipse",
				width: 26,
				height: 26,
			} as any,
		},
		{
			selector: 'node[nodeType="code"][codeKind="file"]',
			style: {
				width: 30,
				height: 30,
			} as any,
		},
		{
			selector: 'node[nodeType="code"][codeKind="function"]',
			style: {
				width: 24,
				height: 24,
			} as any,
		},
		{
			selector: 'node[nodeType="code"][codeKind="method"]',
			style: {
				width: 24,
				height: 24,
			} as any,
		},
		{
			selector: 'node[nodeType="code"][codeKind="class"]',
			style: {
				width: 28,
				height: 28,
			} as any,
		},
		{
			selector: 'node[nodeType="code"][codeKind="interface"]',
			style: {
				width: 28,
				height: 28,
			} as any,
		},
		{
			selector: "node:active",
			style: {
				"overlay-opacity": 0.08,
				"overlay-color": "#6366f1",
			} as any,
		},
		{
			selector: "node.hover",
			style: {
				"border-width": 3,
				width: 31,
				height: 31,
				"z-index": 10,
			} as any,
		},
		{
			selector: "node.selected-node",
			style: {
				"border-width": 4,
				width: 34,
				height: 34,
				"z-index": 11,
			} as any,
		},
		{
			selector: "node.dimmed",
			style: {
				opacity: 0.15,
			} as any,
		},
		{
			selector: "node.highlighted",
			style: {
				opacity: 1,
				"border-width": 3,
			} as any,
		},
		{
			selector: "edge",
			style: {
				width: 1.5,
				"curve-style": "bezier",
				"target-arrow-shape": "triangle",
				"arrow-scale": 0.8,
				"line-color": dimEdge,
				"target-arrow-color": dimEdge,
				"transition-property": "none",
				"transition-duration": 0,
			} as any,
		},
		{
			selector: 'edge[edgeType="parent"]',
			style: {
				"line-color": isDark ? "#6b7280" : "#9ca3af",
				"target-arrow-color": isDark ? "#6b7280" : "#9ca3af",
				"line-style": "solid",
			} as any,
		},
		{
			selector: 'edge[edgeType="spec"]',
			style: {
				"line-color": "#6366f1",
				"target-arrow-color": "#6366f1",
				"line-style": "dashed",
			} as any,
		},
		{
			selector: 'edge[edgeType="mention"]',
			style: {
				"line-color": dimEdge,
				"target-arrow-color": dimEdge,
				"line-style": "dotted",
			} as any,
		},
		{
			selector: 'edge[edgeType="code-ref"]',
			style: {
				"line-color": "#a855f7",
				"target-arrow-color": "#a855f7",
				"line-style": "dashed",
			} as any,
		},
		{
			selector: 'edge[edgeType="calls"]',
			style: {
				"line-color": "#f97316",
				"target-arrow-color": "#f97316",
				"line-style": "solid",
				width: 1.2,
			} as any,
		},
		{
			selector: 'edge[edgeType="imports"]',
			style: {
				"line-color": "#14b8a6",
				"target-arrow-color": "#14b8a6",
				"line-style": "dotted",
				width: 1,
			} as any,
		},
		{
			selector: 'edge[edgeType="contains"]',
			style: {
				"line-color": isDark ? "#6b7280" : "#9ca3af",
				"target-arrow-color": isDark ? "#6b7280" : "#9ca3af",
				"line-style": "solid",
			} as any,
		},
		{
			selector: 'edge[edgeType="implements"]',
			style: {
				"line-color": "#6366f1",
				"target-arrow-color": "#6366f1",
				"line-style": "dashed",
				width: 1.3,
			} as any,
		},
		{
			selector: 'edge[edgeType="instantiates"]',
			style: {
				"line-color": "#eab308",
				"target-arrow-color": "#eab308",
				"line-style": "dashed",
				width: 1.4,
			} as any,
		},
		{
			selector: "edge.dimmed",
			style: {
				opacity: 0.1,
			} as any,
		},
		{
			selector: "edge.highlighted",
			style: {
				opacity: 1,
				width: 2.5,
			} as any,
		},
		{
			selector: "node.search-match",
			style: {
				"border-width": 4,
				"border-color": "#f59e0b",
				opacity: 1,
				"z-index": 10,
			} as any,
		},
		{
			selector: "node.search-neighbor",
			style: {
				opacity: 0.8,
				"border-width": 2,
			} as any,
		},
		{
			selector: "edge.search-path",
			style: {
				opacity: 0.8,
				width: 2,
			} as any,
		},
		{
			selector: "node.impact-root",
			style: {
				"border-width": 5,
				"border-color": "#ef4444",
				opacity: 1,
				"z-index": 10,
			} as any,
		},
		{
			selector: "node.impact-hop1",
			style: {
				opacity: 1,
				"border-width": 3,
				"border-color": "#f97316",
			} as any,
		},
		{
			selector: "node.impact-hop2",
			style: {
				opacity: 0.6,
				"border-width": 2,
				"border-color": "#fbbf24",
			} as any,
		},
		{
			selector: "edge.impact-path",
			style: {
				opacity: 1,
				width: 2.5,
				"line-color": "#f97316",
				"target-arrow-color": "#f97316",
			} as any,
		},
		{
			selector: "node.cluster-colored",
			style: {
				"background-color": "data(clusterColor)",
				"border-color": "data(clusterColor)",
				"border-width": 2,
				opacity: 1,
			} as any,
		},
	];
}
