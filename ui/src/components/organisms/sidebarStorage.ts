import { loadJSON } from "@/ui/components/ui/knowns/blocks/sidebar/sidebar-utils";

/** Where the app sidebar remembers its icon-rail state (localStorage `<key>:collapsed`). */
export const SIDEBAR_STORAGE_KEY = "knowns-sidebar";

/**
 * The remembered rail state, read while rendering. The provider would read it in a layout effect, after a first
 * render at full width, and that change runs the width transition on every load; starting from the stored value
 * means the first render is already the rail.
 */
export function rememberedSidebarCollapsed(): boolean {
	return loadJSON<unknown>(`${SIDEBAR_STORAGE_KEY}:collapsed`, false) === true;
}
