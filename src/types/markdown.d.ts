/**
 * TypeScript declaration for importing markdown files as text
 * Used with esbuild's text loader
 */

declare module "*.md" {
	const content: string;
	export default content;
}
