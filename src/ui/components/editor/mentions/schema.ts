import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from "@blocknote/core";
import { DocMention } from "./DocMention";
import { TaskMention } from "./TaskMention";

/**
 * Custom block specs - only markdown-compatible blocks
 * Removed: image, video, audio, file (not standard markdown)
 */
const { image: _image, video: _video, audio: _audio, file: _file, ...markdownBlockSpecs } = defaultBlockSpecs;

/**
 * BlockNote schema with custom inline content specs for mentions
 * and reduced block types for markdown compatibility
 */
export const schema = BlockNoteSchema.create({
	blockSpecs: markdownBlockSpecs,
	inlineContentSpecs: {
		// Include all default inline content
		...defaultInlineContentSpecs,
		// Add custom mention types
		taskMention: TaskMention,
		docMention: DocMention,
	},
});

/**
 * Type for the BlockNote editor with our custom schema
 */
export type BlockNoteEditorType = typeof schema.BlockNoteEditor;

/**
 * Type for blocks in our schema
 */
export type BlockType = typeof schema.Block;
