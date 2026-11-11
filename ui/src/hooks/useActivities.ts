import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Activity } from "@/ui/api/client";
import { useSSEEvent } from "@/ui/contexts/SSEContext";
import { isUnread, markRead, markUnread, useActivityReadState } from "@/ui/lib/activityReadState";
import { toActivityItem, toNotificationItem } from "@/ui/lib/activityItems";

/** Recent task activity as feed items and notifications, kept fresh over SSE, with per-browser read state. */
export function useActivities(limit: number) {
	const [activities, setActivities] = useState<Activity[]>([]);
	const [loading, setLoading] = useState(true);
	const readState = useActivityReadState();

	const load = useCallback(async () => {
		try {
			setActivities(await api.getActivities({ limit }));
		} catch (err) {
			console.error("Failed to load activities:", err);
		} finally {
			setLoading(false);
		}
	}, [limit]);

	useEffect(() => {
		void load();
	}, [load]);
	useSSEEvent("tasks:updated", () => void load(), [load]);

	const unread = useCallback((id: string, at: number) => isUnread(readState, id, at), [readState]);
	const feedItems = useMemo(() => activities.map((a) => toActivityItem(a, unread)), [activities, unread]);
	const notifications = useMemo(() => activities.map((a) => toNotificationItem(a, unread)), [activities, unread]);

	return { loading, rawActivities: activities, feedItems, notifications, markRead, markUnread };
}
