import { SuggestionMenuController, type SuggestionMenuProps, type DefaultReactSuggestionItem } from "@blocknote/react";
import { ClipboardCheck, FileText } from "lucide-react";
import { search, getTasks, getDocs, type Doc } from "../../../api/client";
import type { Task } from "../../../../models/task";
import type { BlockNoteEditorType } from "./schema";

// Status colors for task items (same as MentionToolbar)
const STATUS_COLORS: Record<string, string> = {
	todo: "bg-muted-foreground/50",
	"in-progress": "bg-yellow-500",
	"in-review": "bg-purple-500",
	blocked: "bg-destructive",
	done: "bg-green-500",
};

interface MentionSuggestionMenuProps {
	editor: BlockNoteEditorType;
}

interface MentionItem extends DefaultReactSuggestionItem {
	id: string;
	itemType: "task" | "doc";
	status?: string;
}

/**
 * Get mention suggestion items based on user input
 */
async function getMentionItems(
	editor: BlockNoteEditorType,
	query: string,
): Promise<MentionItem[]> {
	const items: MentionItem[] = [];

	const lowerQuery = query.toLowerCase();
	const wantsTask = lowerQuery.startsWith("task-") || lowerQuery.startsWith("task ");
	const wantsDoc = lowerQuery.startsWith("doc/") || lowerQuery.startsWith("doc ") || lowerQuery.startsWith("docs/");

	let searchQuery = query;
	if (wantsTask) {
		searchQuery = query.replace(/^task[-\s]/i, "");
	} else if (wantsDoc) {
		searchQuery = query.replace(/^docs?[/\s]/i, "");
	}

	try {
		let tasks: Task[] = [];
		let docs: Doc[] = [];

		if (searchQuery.length > 0) {
			const results = await search(searchQuery);
			tasks = results.tasks;
			docs = results.docs as Doc[];
		} else {
			if (!wantsDoc) {
				tasks = await getTasks();
				tasks = tasks.slice(0, 8);
			}
			if (!wantsTask) {
				docs = await getDocs();
				docs = docs.slice(0, 8);
			}
		}

		if (!wantsDoc) {
			for (const task of tasks.slice(0, 8)) {
				items.push({
					id: `task-${task.id}`,
					title: `#${task.id}: ${task.title}`,
					group: "Tasks",
					itemType: "task",
					status: task.status,
					onItemClick: () => {
						editor.insertInlineContent([
							{
								type: "taskMention",
								props: { taskId: `task-${task.id}` },
							},
							" ",
						]);
					},
				});
			}
		}

		if (!wantsTask) {
			for (const doc of docs.slice(0, 8)) {
				const docPath = doc.path.replace(/\.md$/, "");
				items.push({
					id: docPath,
					title: doc.title || docPath,
					group: "Docs",
					itemType: "doc",
					onItemClick: () => {
						editor.insertInlineContent([
							{
								type: "docMention",
								props: { docPath: docPath },
							},
							" ",
						]);
					},
				});
			}
		}
	} catch (error) {
		console.error("Failed to fetch mention suggestions:", error);
	}

	return items;
}

/**
 * Custom suggestion menu component with shadcn-like styling
 * Synchronized styling with MentionToolbar
 */
function CustomSuggestionMenu(props: SuggestionMenuProps<MentionItem>) {
	const { items, selectedIndex, onItemClick } = props;

	const taskItems = items.filter(item => item.itemType === "task");
	const docItems = items.filter(item => item.itemType === "doc");

	if (items.length === 0) {
		return (
			<div className="z-50 w-56 rounded-md border border-border bg-popover p-1 shadow-md">
				<div className="py-3 text-center text-xs text-muted-foreground">
					No results found
				</div>
			</div>
		);
	}

	return (
		<div className="z-50 w-56 max-h-48 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
			{taskItems.length > 0 && (
				<div className="mb-1">
					<div className="px-2 py-1 text-xs font-medium text-muted-foreground">
						Tasks
					</div>
					{taskItems.map((item) => {
						const globalIndex = items.indexOf(item);
						const isSelected = globalIndex === selectedIndex;
						return (
							<div
								key={item.id}
								className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer ${
									isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
								}`}
								onClick={() => onItemClick?.(item)}
							>
								<ClipboardCheck className="w-3.5 h-3.5 shrink-0 text-green-600 dark:text-green-400" />
								<span className="text-muted-foreground text-xs shrink-0">
									{item.id.replace("task-", "#")}
								</span>
								<span className="truncate flex-1">
									{item.title.replace(/^#\d+:\s*/, "")}
								</span>
								<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[item.status || "todo"] || "bg-muted-foreground/50"}`} />
							</div>
						);
					})}
				</div>
			)}
			{docItems.length > 0 && (
				<div>
					<div className="px-2 py-1 text-xs font-medium text-muted-foreground">
						Docs
					</div>
					{docItems.map((item) => {
						const globalIndex = items.indexOf(item);
						const isSelected = globalIndex === selectedIndex;
						return (
							<div
								key={item.id}
								className={`flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer ${
									isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
								}`}
								onClick={() => onItemClick?.(item)}
							>
								<FileText className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
								<span className="truncate flex-1">{item.title}</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/**
 * Suggestion menu controller for @ mentions
 * Uses custom styled menu component synchronized with MentionToolbar
 */
export function MentionSuggestionMenu({ editor }: MentionSuggestionMenuProps) {
	return (
		<SuggestionMenuController
			triggerCharacter="@"
			getItems={async (query) => getMentionItems(editor, query)}
			suggestionMenuComponent={CustomSuggestionMenu}
		/>
	);
}

export default MentionSuggestionMenu;
