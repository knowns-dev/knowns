import { FileText, ListChecks, ChevronDown, ChevronUp } from "lucide-react";
import { Progress } from "../../components/ui/progress";
import { toDisplayPath, isSpec, getSpecStatus, parseACProgress } from "../../lib/utils";

interface DocData {
  path: string;
  content: string;
  isImported?: boolean;
  metadata: {
    title?: string;
    description?: string;
    tags?: string[];
    updatedAt: string;
  };
}

interface LinkedTask {
  id: string;
  title: string;
  status: string;
  archived?: boolean;
}

interface DocsDocHeaderProps {
  selectedDoc: DocData;
  metaTitle: string;
  setMetaTitle: (v: string) => void;
  metaDescription: string;
  setMetaDescription: (v: string) => void;
  metaTags: string;
  setMetaTags: (v: string) => void;
  handleSaveMetadata: (field: "title" | "description" | "tags") => void;
  linkedTasks: LinkedTask[];
  linkedTasksExpanded: boolean;
  setLinkedTasksExpanded: (v: boolean) => void;
  openTask: (id: string) => void;
}

export function DocsDocHeader({
  selectedDoc,
  metaTitle,
  setMetaTitle,
  metaDescription,
  setMetaDescription,
  metaTags,
  setMetaTags,
  handleSaveMetadata,
  linkedTasks,
  linkedTasksExpanded,
  setLinkedTasksExpanded,
  openTask,
}: DocsDocHeaderProps) {
  return (
    <header className="mb-10">
      {/* Title */}
      {selectedDoc.isImported ? (
        <h1 className="text-4xl font-semibold tracking-tight mb-2 text-balance">
          {selectedDoc.metadata.title}
        </h1>
      ) : (
        <input
          type="text"
          value={metaTitle}
          onChange={(e) => setMetaTitle(e.target.value)}
          onBlur={() => handleSaveMetadata("title")}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="text-4xl font-semibold tracking-tight bg-transparent w-full outline-none border-none p-0 mb-2 placeholder:text-muted-foreground/35"
          placeholder="Untitled"
        />
      )}

      {/* Description */}
      {selectedDoc.isImported ? (
        selectedDoc.metadata.description && (
          <p className="text-[15px] leading-7 text-muted-foreground mb-4 max-w-2xl">
            {selectedDoc.metadata.description}
          </p>
        )
      ) : (
        <input
          type="text"
          value={metaDescription}
          onChange={(e) => setMetaDescription(e.target.value)}
          onBlur={() => handleSaveMetadata("description")}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="text-[15px] leading-7 text-muted-foreground bg-transparent w-full outline-none border-none p-0 mb-4 placeholder:text-muted-foreground/35 max-w-2xl"
          placeholder="Add a description..."
        />
      )}

      {/* Tags */}
      <div className="mb-4 space-y-2">
        {!selectedDoc.isImported ? (
          <input
            type="text"
            value={metaTags}
            onChange={(e) => setMetaTags(e.target.value)}
            onBlur={() => handleSaveMetadata("tags")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="bg-transparent outline-none border-none p-0 text-[12px] text-muted-foreground/75 placeholder:text-muted-foreground/40 w-full"
            placeholder="Add tags..."
          />
        ) : (
          selectedDoc.metadata.tags &&
          selectedDoc.metadata.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedDoc.metadata.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          )
        )}
        <div className="text-[11px] font-mono text-muted-foreground/65 break-all">
          @doc/{toDisplayPath(selectedDoc.path).replace(/\.md$/, "")}
        </div>
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-2.5 flex-wrap text-[11px] text-muted-foreground/85">
        {isSpec(selectedDoc) && (
          <span className="px-2 py-0.5 text-[10px] font-medium bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200 rounded-full">
            SPEC
          </span>
        )}
        {isSpec(selectedDoc) && getSpecStatus(selectedDoc) && (
          <span
            className={`px-2 py-0.5 text-[10px] font-medium rounded-full ${
              getSpecStatus(selectedDoc) === "approved"
                ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                : getSpecStatus(selectedDoc) === "implemented"
                  ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                  : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
            }`}
          >
            {(getSpecStatus(selectedDoc) ?? "").charAt(0).toUpperCase() +
              (getSpecStatus(selectedDoc) ?? "").slice(1)}
          </span>
        )}
        {selectedDoc.isImported && (
          <span className="px-2 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground rounded-full">
            Imported
          </span>
        )}
        <span>
          Updated {new Date(selectedDoc.metadata.updatedAt).toLocaleDateString()}
        </span>
      </div>

      {/* Spec AC Progress */}
      {isSpec(selectedDoc) &&
        (() => {
          const acProgress = parseACProgress(selectedDoc.content);
          return acProgress.total > 0 ? (
            <div className="flex items-center gap-2 mt-4 rounded-2xl bg-muted/35 px-3 py-2 w-fit">
              <ListChecks className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <Progress
                value={Math.round((acProgress.completed / acProgress.total) * 100)}
                className="flex-1 h-1.5 max-w-[180px]"
              />
              <span className="text-xs text-muted-foreground">
                {acProgress.completed}/{acProgress.total}
              </span>
            </div>
          ) : null;
        })()}

      {/* Linked tasks */}
      {isSpec(selectedDoc) && (
        <div className="mt-4 rounded-2xl bg-muted/25 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setLinkedTasksExpanded(!linkedTasksExpanded)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>
              {linkedTasks.length} linked tasks
              {linkedTasks.some((task) => task.archived) &&
                ` (${linkedTasks.filter((task) => task.archived).length} archived)`}
            </span>
            {linkedTasksExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {linkedTasksExpanded && (
            <div className="space-y-1 mt-2">
              {linkedTasks.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tasks are linked to this spec yet.</p>
              ) : (
                linkedTasks.map((task) => (
                  <button
                    type="button"
                    key={task.id}
                    onClick={() => openTask(task.id)}
                    className="flex items-center gap-1.5 p-1.5 rounded-xl hover:bg-accent/60 transition-colors w-full text-left"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        task.status === "done"
                          ? "bg-green-500"
                          : task.status === "in-progress"
                            ? "bg-yellow-500"
                            : task.status === "blocked"
                              ? "bg-red-500"
                              : "bg-gray-400"
                      }`}
                    />
                    <span className="text-xs truncate">{task.title}</span>
                    {task.archived && (
                      <span className="ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        archived
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
