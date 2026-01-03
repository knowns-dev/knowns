import { useEffect, useState, useRef, useCallback } from "react";
import mermaid from "mermaid";
import { useTheme } from "../../App";

interface MermaidRendererProps {
	chart: string;
}

// Counter for unique IDs
let mermaidIdCounter = 0;

/**
 * Mermaid diagram renderer component
 * Renders mermaid diagrams with dark/light theme support
 */
export function MermaidRenderer({ chart }: MermaidRendererProps) {
	const { isDark } = useTheme();
	const [svg, setSvg] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const containerRef = useRef<HTMLDivElement>(null);
	const idRef = useRef<string>(`mermaid-${++mermaidIdCounter}`);

	const renderChart = useCallback(async () => {
		if (!chart?.trim()) {
			setIsLoading(false);
			return;
		}

		setIsLoading(true);
		setError(null);

		try {
			// Initialize mermaid with current theme
			mermaid.initialize({
				startOnLoad: false,
				theme: isDark ? "dark" : "default",
				securityLevel: "loose",
				fontFamily: "inherit",
			});

			// Generate unique ID for this render
			const id = `${idRef.current}-${Date.now()}`;

			// Render the chart
			const { svg: renderedSvg } = await mermaid.render(id, chart.trim());

			setSvg(renderedSvg);
			setError(null);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Failed to render diagram";
			setError(errorMessage);
			setSvg("");
			console.error("Mermaid render error:", err);
		} finally {
			setIsLoading(false);
		}
	}, [chart, isDark]);

	useEffect(() => {
		renderChart();
	}, [renderChart]);

	// Cleanup any orphaned mermaid elements on unmount
	useEffect(() => {
		return () => {
			// Remove any temporary elements mermaid may have created
			const tempElements = document.querySelectorAll(`[id^="${idRef.current}"]`);
			tempElements.forEach((el) => el.remove());
		};
	}, []);

	if (error) {
		return (
			<div className="p-4 my-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
				<p className="text-red-600 dark:text-red-400 text-sm font-medium">
					Mermaid Error: {error}
				</p>
				<pre className="mt-2 text-xs overflow-auto p-2 bg-red-100 dark:bg-red-900/30 rounded whitespace-pre-wrap">
					{chart}
				</pre>
			</div>
		);
	}

	if (isLoading || !svg) {
		return (
			<div className="flex items-center justify-center p-4 my-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
				<div className="animate-pulse text-gray-400">Loading diagram...</div>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="mermaid-container my-4 flex justify-center overflow-x-auto p-4 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid SVG output is safe
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}

export default MermaidRenderer;
