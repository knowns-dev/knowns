export type NotificationType = "mention" | "agent" | "update";
export type NotificationTab = "all" | "mentions" | "agents";

export interface NotificationLike {
  id: string;
  type: NotificationType;
  at: number;
  read?: boolean;
}

export const TAB_TYPE: Record<NotificationTab, NotificationType | null> = { all: null, mentions: "mention", agents: "agent" };

/** The items one tab shows, newest first. */
export function forTab<T extends NotificationLike>(items: readonly T[], tab: NotificationTab): T[] {
  const type = TAB_TYPE[tab];
  return items.filter((i) => !type || i.type === type).sort((a, b) => b.at - a.at);
}

export function unreadCount(items: readonly NotificationLike[], tab: NotificationTab = "all"): number {
  const type = TAB_TYPE[tab];
  return items.reduce((n, i) => n + (!i.read && (!type || i.type === type) ? 1 : 0), 0);
}

/** "12" or "99+" for the bell badge; "" when nothing is unread. */
export function badgeText(count: number, max = 99): string {
  return count <= 0 ? "" : count > max ? `${max}+` : String(count);
}

/** "3 unread notifications", "1 unread notification", "No unread notifications". */
export function unreadSentence(count: number): string {
  return count === 0 ? "No unread notifications" : `${count} unread notification${count === 1 ? "" : "s"}`;
}

/** Ids in `next` that were not in `prev` (what arrived). */
export function arrivals(prev: ReadonlySet<string>, next: readonly { id: string }[]): string[] {
  return next.filter((i) => !prev.has(i.id)).map((i) => i.id);
}
