import { CircleDot, FileText, UserRound } from "lucide-react";
import { ActivityFeed, type ActivityTypeMeta } from "@/ui/components/ui/knowns/blocks/application/activity-feed";
import { useActivities } from "@/ui/hooks/useActivities";
import { navigateTo } from "../../lib/navigation";

const TYPE_META: Record<string, ActivityTypeMeta> = {
	status: { label: "Status", icon: <CircleDot className="size-4" aria-hidden="true" /> },
	assignee: { label: "Assignments", icon: <UserRound className="size-4" aria-hidden="true" /> },
	content: { label: "Edits", icon: <FileText className="size-4" aria-hidden="true" /> },
};

/** The dashboard's "Recent activity": task history as a feed with type tabs and per-browser unread state. */
export function RecentActivity() {
	const { feedItems, markRead } = useActivities(50);
	return (
		<div className="px-2 pb-2">
			<ActivityFeed
				label="Recent activity"
				items={feedItems}
				now={Date.now()}
				timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
				typeMeta={TYPE_META}
				emptyText="No recent activity"
				onMarkRead={(ids) => markRead(ids)}
				onMarkAllRead={(ids) => markRead(ids)}
				onOpen={(item) => {
					markRead([item.id]);
					navigateTo(`/tasks/${item.id.split(":")[0]}`);
				}}
			/>
		</div>
	);
}
