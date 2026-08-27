import { useState, useEffect } from "react";
import { getTask } from "../../api/client";
import { navigateTo } from "../../lib/navigation";
import { STATUS_STYLES, taskMentionClass, taskMentionBrokenClass } from "./mentionUtils";

export function TaskMentionBadge({
  taskId,
  onTaskLinkClick,
}: {
  taskId: string;
  onTaskLinkClick?: (taskId: string) => void;
}) {
  const [title, setTitle] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const taskNumber = taskId.replace("task-", "");

  useEffect(() => {
    let cancelled = false;

    getTask(taskNumber)
      .then((task) => {
        if (!cancelled) {
          setTitle(task.title);
          setStatus(task.status);
          setNotFound(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTitle(null);
          setStatus(null);
          setNotFound(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [taskNumber]);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (notFound) return;
    if (onTaskLinkClick) {
      onTaskLinkClick(taskNumber);
    } else {
      navigateTo(`/tasks/${taskNumber}`);
    }
  };

  const statusStyle = status
    ? STATUS_STYLES[status] || STATUS_STYLES.todo
    : null;

  const mentionClass = notFound ? taskMentionBrokenClass : taskMentionClass;

  return (
    <span
      role={notFound ? undefined : "link"}
      className={mentionClass}
      data-task-id={taskNumber}
      onClick={handleClick}
      title={notFound ? `Task not found: ${taskNumber}` : title || undefined}
    >
      {statusStyle && (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusStyle}`} />
      )}
      {loading ? (
        <span className="opacity-60">#{taskNumber}</span>
      ) : title ? (
        <span className="max-w-[250px] truncate">{title}</span>
      ) : (
        <span>#{taskNumber}</span>
      )}
    </span>
  );
}
