import { useState } from "react";
import { NotificationCenter } from "@/ui/components/ui/knowns/blocks/application/notification-center";
import { useActivities } from "@/ui/hooks/useActivities";
import { navigateTo } from "../../lib/navigation";

/** The bell: recent task activity as notifications, with unread state kept in this browser. */
export default function NotificationBell() {
	const [open, setOpen] = useState(false);
	const { notifications, markRead, markUnread } = useActivities(50);

	return (
		<NotificationCenter
			label="Notifications"
			open={open}
			onOpenChange={setOpen}
			items={notifications}
			now={Date.now()}
			timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
			emptyText="No recent activity"
			onRead={(id, read) => (read ? markRead([id]) : markUnread(id))}
			onReadAll={(ids) => markRead(ids)}
			onOpen={(item) => {
				markRead([item.id]);
				setOpen(false);
				navigateTo(`/tasks/${item.id.split(":")[0]}`);
			}}
		/>
	);
}
