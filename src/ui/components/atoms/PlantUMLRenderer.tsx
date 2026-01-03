import { useEffect, useState, useRef, useCallback } from "react";
import { useTheme } from "../../App";

interface PlantUMLRendererProps {
	chart: string;
}

/**
 * PlantUML diagram renderer component
 * Renders PlantUML diagrams using the PlantUML server
 */
export function PlantUMLRenderer({ chart }: PlantUMLRendererProps) {
	const { isDark } = useTheme();
	const [imageUrl, setImageUrl] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const containerRef = useRef<HTMLDivElement>(null);

	const renderChart = useCallback(async () => {
		if (!chart?.trim()) {
			setIsLoading(false);
			return;
		}

		setIsLoading(true);
		setError(null);

		try {
			// Encode PlantUML text using deflate + base64
			const encoded = await encodePlantUML(chart.trim());
			
			// Use public PlantUML server
			const serverUrl = "https://www.plantuml.com/plantuml";
			const format = "svg"; // SVG for better quality and theme support
			const url = `${serverUrl}/${format}/${encoded}`;

			setImageUrl(url);
			setError(null);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Failed to render PlantUML diagram";
			setError(errorMessage);
			setImageUrl("");
			console.error("PlantUML render error:", err);
		} finally {
			setIsLoading(false);
		}
	}, [chart, isDark]);

	useEffect(() => {
		renderChart();
	}, [renderChart]);

	if (error) {
		return (
			<div className="p-4 my-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
				<p className="text-red-600 dark:text-red-400 text-sm font-medium">
					PlantUML Error: {error}
				</p>
				<pre className="mt-2 text-xs overflow-auto p-2 bg-red-100 dark:bg-red-900/30 rounded whitespace-pre-wrap">
					{chart}
				</pre>
			</div>
		);
	}

	if (isLoading || !imageUrl) {
		return (
			<div className="flex items-center justify-center p-4 my-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
				<div className="animate-pulse text-gray-400">Loading PlantUML diagram...</div>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className="plantuml-container my-4 flex justify-center overflow-x-auto p-4 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
		>
			<img
				src={imageUrl}
				alt="PlantUML Diagram"
				className="max-w-full h-auto"
				onError={() => setError("Failed to load PlantUML image from server")}
			/>
		</div>
	);
}

/**
 * Encode PlantUML text using PlantUML text encoding
 * Based on: https://plantuml.com/text-encoding
 * Uses browser's CompressionStream API for deflate compression
 */
async function encodePlantUML(text: string): Promise<string> {
	try {
		// Step 1: UTF-8 encode
		const utf8Bytes = new TextEncoder().encode(text);
		
		// Step 2: Deflate compression using CompressionStream
		const compressedStream = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(utf8Bytes);
					controller.close();
				}
			}).pipeThrough(new CompressionStream('deflate-raw'))
		);
		
		const compressedBytes = new Uint8Array(await compressedStream.arrayBuffer());
		
		// Step 3: Convert to PlantUML-specific base64
		const encoded = encode64(compressedBytes);
		
		return encoded;
	} catch (err) {
		// Fallback: if compression fails, use uncompressed encoding
		console.warn("Compression failed, using fallback encoding:", err);
		const utf8Bytes = new TextEncoder().encode(text);
		return encode64(utf8Bytes);
	}
}

/**
 * PlantUML-specific base64 encoding
 * Uses a custom alphabet: 0-9A-Za-z-_
 */
function encode64(data: Uint8Array): string {
	let r = "";
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
	
	for (let i = 0; i < data.length; i += 3) {
		const b1 = data[i] ?? 0;
		const b2 = data[i + 1] ?? 0;
		const b3 = data[i + 2] ?? 0;
		
		r += append3bytes(b1, b2, b3, alphabet);
	}
	return r;
}

/**
 * Append 3 bytes encoded as 4 characters
 */
function append3bytes(b1: number, b2: number, b3: number, alphabet: string): string {
	const c1 = b1 >> 2;
	const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
	const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
	const c4 = b3 & 0x3f;
	let r = "";
	r += alphabet.charAt(c1 & 0x3f);
	r += alphabet.charAt(c2 & 0x3f);
	r += alphabet.charAt(c3 & 0x3f);
	r += alphabet.charAt(c4 & 0x3f);
	return r;
}

export default PlantUMLRenderer;

