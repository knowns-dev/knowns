/**
 * Node.js module hooks for loading .md files as text
 */

import { readFile } from "node:fs/promises";

export async function load(url, context, nextLoad) {
	if (url.endsWith(".md")) {
		const content = await readFile(new URL(url), "utf-8");
		return {
			format: "module",
			shortCircuit: true,
			source: `export default ${JSON.stringify(content)};`,
		};
	}
	return nextLoad(url, context);
}
