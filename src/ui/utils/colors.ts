/**
 * Color utility functions for generating Tailwind classes from color names
 */

export type ColorName =
	| "gray"
	| "red"
	| "orange"
	| "yellow"
	| "green"
	| "blue"
	| "purple"
	| "pink"
	| "indigo"
	| "teal"
	| "cyan";

export interface StatusColorScheme {
	// For TaskCard badge
	bg: string;
	darkBg: string;
	text: string;
	darkText: string;
	// For Column background
	columnBg: string;
	columnBorder: string;
	columnBgDark: string;
	columnBorderDark: string;
}

/**
 * Generate Tailwind color classes from color name
 */
export function generateColorScheme(colorName: ColorName | string): StatusColorScheme {
	const safeColor = colorName as ColorName;

	return {
		// TaskCard badge colors
		bg: `bg-${safeColor}-100`,
		darkBg: `bg-${safeColor}-900/50`,
		text: `text-${safeColor}-700`,
		darkText: `text-${safeColor}-300`,

		// Column background colors
		columnBg: `bg-${safeColor}-50`,
		columnBorder: `border-${safeColor}-200`,
		columnBgDark: `bg-${safeColor}-900/30`,
		columnBorderDark: `border-${safeColor}-800`,
	};
}

/**
 * Default color fallback
 */
export const DEFAULT_COLOR_SCHEME: StatusColorScheme = {
	bg: "bg-gray-100",
	darkBg: "bg-gray-700",
	text: "text-gray-700",
	darkText: "text-gray-300",
	columnBg: "bg-gray-50",
	columnBorder: "border-gray-200",
	columnBgDark: "bg-gray-800",
	columnBorderDark: "border-gray-700",
};

/**
 * Default status color mapping
 */
export const DEFAULT_STATUS_COLORS: Record<string, ColorName> = {
	todo: "gray",
	"in-progress": "blue",
	"in-review": "purple",
	done: "green",
	blocked: "red",
	"on-hold": "yellow",
	urgent: "orange",
};
