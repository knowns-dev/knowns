import { useEffect, useState } from "react";

/**
 * The size of an element that may mount later (the canvas only renders once the graph has
 * loaded), so it takes a callback ref instead of a ref object: `<main ref={ref}>`.
 */
export function useContainerSize<T extends HTMLElement = HTMLElement>() {
	const [element, setElement] = useState<T | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	useEffect(() => {
		if (!element) {
			setSize({ width: 0, height: 0 });
			return;
		}

		const update = () => {
			setSize({
				width: element.clientWidth,
				height: element.clientHeight,
			});
		};

		update();
		const observer = new ResizeObserver(() => update());
		observer.observe(element);

		return () => observer.disconnect();
	}, [element]);

	return { ref: setElement, ...size };
}
