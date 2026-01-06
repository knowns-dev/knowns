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

/**
 * Pre-defined status badge classes for Tailwind JIT
 * Uses dark: variant for automatic theme switching
 */
const STATUS_BADGE_CLASSES: Record<ColorName, string> = {
	gray: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
	red: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
	orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
	yellow: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
	green: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
	blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
	purple: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
	pink: "bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-300",
	indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300",
	teal: "bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300",
	cyan: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300",
};

/**
 * Get status badge classes with dark mode support
 */
export function getStatusBadgeClasses(
	status: string,
	statusColors: Record<string, ColorName> = DEFAULT_STATUS_COLORS,
): string {
	const colorName = statusColors[status] || "gray";
	return STATUS_BADGE_CLASSES[colorName] || STATUS_BADGE_CLASSES.gray;
}

/**
 * Pre-defined column classes for Tailwind JIT
 */
const COLUMN_CLASSES: Record<ColorName, { bg: string; border: string }> = {
	gray: {
		bg: "bg-gray-50 dark:bg-gray-800",
		border: "border-gray-200 dark:border-gray-700",
	},
	red: {
		bg: "bg-red-50 dark:bg-red-900/30",
		border: "border-red-200 dark:border-red-800",
	},
	orange: {
		bg: "bg-orange-50 dark:bg-orange-900/30",
		border: "border-orange-200 dark:border-orange-800",
	},
	yellow: {
		bg: "bg-yellow-50 dark:bg-yellow-900/30",
		border: "border-yellow-200 dark:border-yellow-800",
	},
	green: {
		bg: "bg-green-50 dark:bg-green-900/30",
		border: "border-green-200 dark:border-green-800",
	},
	blue: {
		bg: "bg-blue-50 dark:bg-blue-900/30",
		border: "border-blue-200 dark:border-blue-800",
	},
	purple: {
		bg: "bg-purple-50 dark:bg-purple-900/30",
		border: "border-purple-200 dark:border-purple-800",
	},
	pink: {
		bg: "bg-pink-50 dark:bg-pink-900/30",
		border: "border-pink-200 dark:border-pink-800",
	},
	indigo: {
		bg: "bg-indigo-50 dark:bg-indigo-900/30",
		border: "border-indigo-200 dark:border-indigo-800",
	},
	teal: {
		bg: "bg-teal-50 dark:bg-teal-900/30",
		border: "border-teal-200 dark:border-teal-800",
	},
	cyan: {
		bg: "bg-cyan-50 dark:bg-cyan-900/30",
		border: "border-cyan-200 dark:border-cyan-800",
	},
};

/**
 * Get column classes with dark mode support
 */
export function getColumnClasses(
	status: string,
	statusColors: Record<string, ColorName> = DEFAULT_STATUS_COLORS,
): { bg: string; border: string } {
	const colorName = statusColors[status] || "gray";
	return COLUMN_CLASSES[colorName] || COLUMN_CLASSES.gray;
}

/**
 * Default status labels mapping
 */
export const DEFAULT_STATUS_LABELS: Record<string, string> = {
	todo: "To Do",
	"in-progress": "In Progress",
	"in-review": "In Review",
	done: "Done",
	blocked: "Blocked",
	"on-hold": "On Hold",
	urgent: "Urgent",
};

/**
 * Get readable label from status slug
 */
export function getStatusLabel(status: string): string {
	if (DEFAULT_STATUS_LABELS[status]) {
		return DEFAULT_STATUS_LABELS[status];
	}
	// Fallback: convert slug to title case
	return status
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * Build status options from config statuses
 */
export function buildStatusOptions(statuses: string[]): { value: string; label: string }[] {
	return statuses.map((status) => ({
		value: status,
		label: getStatusLabel(status),
	}));
}
