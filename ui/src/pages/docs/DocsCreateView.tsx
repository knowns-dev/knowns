import { useState } from "react";
import { Check, ArrowLeft, Menu } from "lucide-react";
import { MDEditor } from "../../components/editor";
import { Button } from "../../components/ui/button";
import { createDoc } from "../../api/client";

interface DocsCreateViewProps {
  currentFolder: string | null;
  onClose: () => void;
  onCreated: () => void;
  onOpenMobileSidebar: () => void;
}

export function DocsCreateView({ currentFolder, onClose, onCreated, onOpenMobileSidebar }: DocsCreateViewProps) {
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocDescription, setNewDocDescription] = useState("");
  const [newDocTags, setNewDocTags] = useState("");
  const [newDocFolder, setNewDocFolder] = useState(currentFolder || "");
  const [newDocContent, setNewDocContent] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreateDoc = async () => {
    if (!newDocTitle.trim()) return;
    setCreating(true);
    try {
      const tags = newDocTags.split(",").map((t) => t.trim()).filter((t) => t);
      await createDoc({
        title: newDocTitle,
        description: newDocDescription,
        tags,
        folder: newDocFolder,
        content: newDocContent,
      });
      onCreated();
    } catch (err) {
      console.error("Failed to create doc:", err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/55 bg-background px-2 sm:px-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenMobileSidebar}
          className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground lg:hidden"
        aria-label="Browse docs"
        >
          <Menu className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          disabled={creating}
          className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <span className="hidden sm:inline">Back</span>
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={handleCreateDoc} disabled={creating || !newDocTitle.trim()} className="h-8 gap-1.5">
          <Check className="size-3.5" />
          <span>{creating ? "Creating..." : "Create"}</span>
        </Button>
      </div>

      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
        <div className="px-6 pt-6 pb-4 shrink-0 flex justify-center">
          <div className="w-full max-w-[720px]">
            <input
              type="text"
              value={newDocTitle}
              onChange={(e) => setNewDocTitle(e.target.value)}
              className="text-3xl font-semibold tracking-tight bg-transparent w-full outline-none border-none p-0 mb-1 placeholder:text-muted-foreground/40"
              placeholder="Untitled"
              autoFocus
            />
            <input
              type="text"
              value={newDocDescription}
              onChange={(e) => setNewDocDescription(e.target.value)}
              className="text-base text-muted-foreground bg-transparent w-full outline-none border-none p-0 mb-4 placeholder:text-muted-foreground/40"
              placeholder="Add a description..."
            />
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground/60">Folder</span>
                <input
                  type="text"
                  value={newDocFolder}
                  onChange={(e) => setNewDocFolder(e.target.value)}
                  className="bg-transparent outline-none border-none p-0 text-xs text-foreground placeholder:text-muted-foreground/40 w-[120px]"
                  placeholder="root"
                />
              </div>
              <span className="text-border">|</span>
              <div className="flex items-center gap-1.5 flex-1">
                <span className="text-muted-foreground/60 shrink-0">Tags</span>
                <input
                  type="text"
                  value={newDocTags}
                  onChange={(e) => setNewDocTags(e.target.value)}
                  className="bg-transparent outline-none border-none p-0 text-xs text-foreground placeholder:text-muted-foreground/40 flex-1"
                  placeholder="guide, tutorial, api"
                />
              </div>
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-0 px-6 pb-6">
          <MDEditor
            markdown={newDocContent}
            onChange={setNewDocContent}
            placeholder="Write your documentation here..."
            height="100%"
            className="h-full"
          />
        </div>
      </div>
    </>
  );
}
