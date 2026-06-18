import {
  type ClipboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  Check,
  ChevronsUpDown,
  FileText,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
  Tag,
  X,
} from "lucide-react";

import type {
  ChatComposerFile,
  ChatQuestionBlock,
  OpenCodeCatalogProvider,
  OpenCodeCatalogState,
} from "../../../models/chat";
import type { SlashItem } from "../../../data/skills";
import type { Task } from "../../../models/task";
import type { OpenCodePendingPermission } from "../../../api/client";
import { search } from "../../../api/client";
import { normalizeKnownsTaskReferences } from "../../../lib/knownsReferences";
import { supportsImageInputForModel } from "../../../lib/opencodeModels";
import { cn } from "../../../lib/utils";
import { QuestionBlock } from "../../chat/QuestionBlock";
import { PermissionDialog } from "../../chat/PermissionDialog";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Sheet, SheetContent } from "../../ui/sheet";
import { OpenCodeModelManagerDialog } from "../OpenCodeModelManagerDialog";
import { toast } from "../../ui/sonner";
import type { ChatTodoItem } from "./helpers";
import { ChatTodoPanel } from "./ChatTodoPanel";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { useContextUsage } from "../../../hooks/useContextUsage";
import type { ChatMessage } from "../../../models/chat";

interface ChatInputProps {
  onSend: (message: string, files?: ChatComposerFile[]) => void;
  onSubmitQuestion?: (
    messageId: string,
    blockId: string,
    answers: string[][],
  ) => Promise<void> | void;
  onRejectQuestion?: (
    messageId: string,
    blockId: string,
  ) => Promise<void> | void;
  onRespondPermission?: (
    permissionId: string,
    response: "once" | "always" | "reject",
  ) => Promise<void> | void;
  onStop: () => void;
  isStreaming: boolean;
  disabled: boolean;
  queueCount?: number;
  providers: OpenCodeCatalogProvider[];
  catalog: OpenCodeCatalogState;
  currentModel?: string | null;
  currentVariant?: string | null;
  onModelChange: (modelKey: string | null, variant?: string | null) => void;
  onSetDefaultModel: (modelKey: string | null) => void;
  onSetDefaultVariant?: (modelKey: string, variant: string | null) => void;
  onUpdateModelPref: (
    modelKey: string,
    patch: { enabled?: boolean; pinned?: boolean },
  ) => void;
  onToggleProviderHidden?: (
    providerID: string,
    hidden: boolean,
    modelKeys?: string[],
  ) => void;
  lastLoadedAt?: string | null;
  slashItems?: SlashItem[];
  autoModelLabel?: string;
  todos?: ChatTodoItem[];
  quickCommands?: string[];
  activeQuestion?: {
    messageId: string;
    block: ChatQuestionBlock;
  } | null;
  activePermission?: OpenCodePendingPermission | null;
  restoreValue?: string | null;
  onRestoreValueConsumed?: () => void;
  sessionId?: string;
  messages?: ChatMessage[];
  sessionModelID?: string;
  sessionModelName?: string;
  sessionProviderID?: string;
  providerResponse?: import("../../../api/client").OpenCodeProviderResponse | null;
}

export function ChatInput({
  onSend,
  onSubmitQuestion,
  onRejectQuestion,
  onRespondPermission,
  onStop,
  isStreaming,
  disabled,
  queueCount = 0,
  providers,
  catalog,
  currentModel,
  currentVariant,
  onModelChange,
  onSetDefaultModel,
  onSetDefaultVariant,
  onUpdateModelPref,
  onToggleProviderHidden,
  lastLoadedAt,
  slashItems = [],
  autoModelLabel = "Auto",
  todos = [],
  quickCommands = [],
  activeQuestion = null,
  activePermission = null,
  restoreValue = null,
  onRestoreValueConsumed,
  sessionId,
  messages,
  sessionModelID,
  sessionModelName,
  sessionProviderID,
  providerResponse,
}: ChatInputProps) {
  const MAX_TEXTAREA_HEIGHT = 240;
  const [value, setValue] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [files, setFiles] = useState<ChatComposerFile[]>([]);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");

  const contextUsage = useContextUsage(messages, sessionModelID, sessionProviderID, providerResponse);
  const [mentionResults, setMentionResults] = useState<{
    tasks: Task[];
    docs: Array<{ path: string; title: string }>;
  }>({ tasks: [], docs: [] });
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  const [referencePopupOpen, setReferencePopupOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{
    tasks: Task[];
    docs: Array<{ path: string; title: string }>;
  }>({ tasks: [], docs: [] });

  const draftStorageKey = useMemo(
    () => (sessionId ? `knowns.chat.draft.${sessionId}` : null),
    [sessionId],
  );

  // Restore value when revert is triggered
  useEffect(() => {
    if (restoreValue) {
      setValue(restoreValue);
      onRestoreValueConsumed?.();
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [restoreValue, onRestoreValueConsumed]);

  useEffect(() => {
	if (!draftStorageKey) {
		setValue("");
		setFiles([]);
		return;
	}
	try {
		const savedDraft = window.localStorage.getItem(draftStorageKey);
		setValue(savedDraft || "");
		setFiles([]);
	} catch {
		setValue("");
		setFiles([]);
	}
  }, [draftStorageKey]);

  useEffect(() => {
	if (!draftStorageKey) return;
	try {
		if (value.trim().length === 0) {
			window.localStorage.removeItem(draftStorageKey);
			return;
		}
		window.localStorage.setItem(draftStorageKey, value);
	} catch {
		// Best-effort draft persistence.
	}
  }, [draftStorageKey, value]);

  const filteredSkills = useMemo(() => {
    const query = value.trimStart();
    if (!query.startsWith("/")) return [];
    const normalized = query.toLowerCase();
    const scoreSkillMatch = (skill: (typeof slashItems)[number]) => {
      const name = skill.name.toLowerCase();
      const exact = name === normalized ? 1000 : 0;
      const prefixBonus = name.startsWith(normalized) ? 500 : 0;
      const segment = name.slice(1);
      const querySegment = normalized.slice(1);
      const segmentExact = segment === querySegment ? 200 : 0;
      const segmentStartsWith = segment.startsWith(querySegment) ? 100 : 0;
      const lengthBonus = Math.max(0, 50 - Math.max(0, name.length - normalized.length));
      return exact + prefixBonus + segmentExact + segmentStartsWith + lengthBonus;
    };

    return slashItems
      .filter((skill) => skill.name.toLowerCase().startsWith(normalized))
      .sort((left, right) => {
        const scoreDiff = scoreSkillMatch(right) - scoreSkillMatch(left);
        if (scoreDiff !== 0) return scoreDiff;
        return left.name.localeCompare(right.name);
      });
  }, [slashItems, value]);

  const filteredWorkflowItems = useMemo(
    () => filteredSkills.filter((skill) => skill.source !== "command"),
    [filteredSkills],
  );

  const filteredCommandItems = useMemo(
    () => filteredSkills.filter((skill) => skill.source === "command"),
    [filteredSkills],
  );

  const visibleSlashItems = useMemo(
    () => [...filteredWorkflowItems, ...filteredCommandItems],
    [filteredWorkflowItems, filteredCommandItems],
  );

  const selectedModel = useMemo(
    () =>
      [...catalog.models, ...catalog.staleModels].find(
        (model) => model.key === currentModel,
      ),
    [currentModel, catalog.models, catalog.staleModels],
  );

  const modelVariants = selectedModel?.variants ? Object.keys(selectedModel.variants) : [];
  const hasVariants = modelVariants.length > 0;

  const autoModelProvider = useMemo(() => {
    if (!catalog.effectiveDefault) return null;
    return (
      catalog.models.find(
        (model) => model.key === catalog.effectiveDefault?.key,
      ) || null
    );
  }, [catalog.effectiveDefault, catalog.models]);

  const activeProviderMeta = selectedModel || autoModelProvider;
  const imageUploadSupported = supportsImageInputForModel(
    activeProviderMeta || catalog.effectiveDefault,
  );
  const questionPending = Boolean(
    activeQuestion &&
    activeQuestion.block.status !== "submitted" &&
    activeQuestion.block.status !== "rejected",
  );
  const permissionPending = Boolean(activePermission);
  const composerLocked = questionPending || permissionPending;

  const submit = () => {
    if (
      (!value.trim() && files.length === 0) ||
      disabled ||
      questionPending ||
      permissionPending
    )
      return;
    if (files.length > 0 && !imageUploadSupported) return;
    onSend(normalizeKnownsTaskReferences(value.trim()), files);
    if (draftStorageKey) {
		try {
			window.localStorage.removeItem(draftStorageKey);
		} catch {
			// ignore localStorage failures
		}
	}
    setValue("");
    setFiles([]);
  };

  const loadComposerFiles = async (inputFiles: File[]) => {
    if (inputFiles.length === 0) return [];

    const loaded = await Promise.all(
      inputFiles.map(
        (file) =>
          new Promise<ChatComposerFile>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                id: `${file.name}_${file.size}_${file.lastModified}`,
                mime: file.type || "application/octet-stream",
                url: typeof reader.result === "string" ? reader.result : "",
                filename: file.name || `pasted-image-${Date.now()}.png`,
              });
            reader.onerror = () =>
              reject(reader.error || new Error("Failed to read file"));
            reader.readAsDataURL(file);
          }),
      ),
    );

    return loaded.filter((file) => file.url);
  };

  const getClipboardImageFiles = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const filesFromItems = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (filesFromItems.length > 0) {
      return filesFromItems;
    }

    const filesFromClipboard = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );

    return filesFromClipboard;
  };

  const handleSelectFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.target.files || []);
    if (nextFiles.length === 0) return;
    const loaded = await loadComposerFiles(nextFiles);
    setFiles((current) => [...current, ...loaded]);
    event.target.value = "";
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = getClipboardImageFiles(event);

    if (clipboardFiles.length === 0) return;

    if (!imageUploadSupported) {
      toast.warning("Current model does not support image input.");
      return;
    }

    event.preventDefault();
    void loadComposerFiles(clipboardFiles)
      .then((loaded) => {
        if (loaded.length === 0) return;
        setFiles((current) => [...current, ...loaded]);
      })
      .catch(() => {
        toast.error("Failed to read pasted image.");
      });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || isComposingRef.current) return;
    if (visibleSlashItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSkillIndex((current) => (current + 1) % visibleSlashItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSkillIndex((current) =>
          current === 0 ? visibleSlashItems.length - 1 : current - 1,
        );
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        insertSkill(visibleSlashItems[selectedSkillIndex]?.name);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        insertSkill(visibleSlashItems[selectedSkillIndex]?.name);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    setSelectedSkillIndex(0);
  }, [value]);

  useEffect(() => {
    slashItemRefs.current = slashItemRefs.current.slice(0, visibleSlashItems.length);
    const activeItem = slashItemRefs.current[selectedSkillIndex];
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [visibleSlashItems, selectedSkillIndex]);

  useEffect(() => {
    if (selectedSkillIndex >= visibleSlashItems.length) {
      setSelectedSkillIndex(0);
    }
  }, [selectedSkillIndex, visibleSlashItems.length]);

  useEffect(() => {
    const mentionMatch = value.match(/@(?<type>task|doc)?(?<query>[a-zA-Z0-9.-]*)$/);
    if (mentionMatch) {
      setMentionOpen(false);
    } else {
      setMentionOpen(false);
    }
  }, [value]);

  useEffect(() => {
    if (referencePopupOpen && searchQuery !== "") {
      search(searchQuery).then((results) => {
        setSearchResults({
          tasks: results.tasks.slice(0, 10),
          docs: (results.docs as Array<{ path: string; title: string }>).slice(0, 10),
        });
      }).catch(() => {
        setSearchResults({ tasks: [], docs: [] });
      });
    } else if (referencePopupOpen) {
      search("").then((results) => {
        setSearchResults({
          tasks: results.tasks.slice(0, 10),
          docs: (results.docs as Array<{ path: string; title: string }>).slice(0, 10),
        });
      }).catch(() => {
        setSearchResults({ tasks: [], docs: [] });
      });
    }
  }, [referencePopupOpen, searchQuery]);

  const insertMention = (type: "task" | "doc", id: string, label: string) => {
    const mentionText = type === "task" ? `@task/${id}` : `@doc/${id}`;
    const match = value.match(/@(?<prefix>task[-/]|doc\/)?(?<suffix>[a-zA-Z0-9.-]*)$/);
    if (match) {
      const prefix = match.groups?.prefix || "";
      const insertPosition = value.length - (match[0].length - prefix.length);
      const newValue = value.slice(0, insertPosition) + mentionText + " ";
      setValue(newValue);
    } else {
      setValue(value + mentionText + " ");
    }
    setMentionOpen(false);
    setReferencePopupOpen(false);
    setSearchQuery("");
    textareaRef.current?.focus();
  };

  const openSearchPopup = () => {
    setReferencePopupOpen(true);
    setSearchQuery("");
    search("").then((results) => {
      setSearchResults({
        tasks: results.tasks.slice(0, 10),
        docs: (results.docs as Array<{ path: string; title: string }>).slice(0, 10),
      });
    }).catch(() => {
      setSearchResults({ tasks: [], docs: [] });
    });
  };

  const insertSkill = (skillName?: string) => {
    if (!skillName) return;
    const newValue = value.replace(/^\/[\w-]*/, skillName) + (value.endsWith(" ") ? "" : " ");
    setValue(newValue);
    textareaRef.current?.focus();
  };

  return (
    <div className={cn('shrink-0', 'bg-transparent', 'px-4', 'pb-5', 'pt-3')}>
      <div className={cn('mx-auto', 'max-w-4xl', 'space-y-3', 'px-1', 'lg:px-5')}>
        <ChatTodoPanel todos={todos} variant="inline" />
        {!questionPending && !permissionPending && quickCommands.length > 0 && (
          <div className={cn('flex', 'flex-wrap', 'items-center', 'gap-2')}>
            <span className={cn('text-[11px]', 'font-medium', 'uppercase', 'tracking-[0.14em]', 'text-muted-foreground')}>
              Quick commands
            </span>
            {quickCommands.map((command) => (
              <button
                key={command}
                type="button"
                onClick={() => onSend(command)}
                disabled={disabled || questionPending || permissionPending}
                className={cn('rounded-md', 'border', 'border-border/60', 'bg-background', 'px-2.5', 'py-1', 'text-xs', 'text-foreground', 'transition-colors', 'hover:bg-accent', 'disabled:cursor-not-allowed', 'disabled:opacity-50')}
                title={`Run ${command}`}
              >
                {command}
              </button>
            ))}
          </div>
        )}
        {activeQuestion && onSubmitQuestion && (
          <div className={cn('rounded-2xl', 'border', 'border-border/50', 'bg-[#fafaf8]', 'dark:bg-muted/10', 'p-2', 'sm:p-3', 'shadow-sm')}>
            <QuestionBlock
              block={activeQuestion.block}
              variant="prompt"
              onSubmit={(blockId, answers) =>
                onSubmitQuestion(activeQuestion.messageId, blockId, answers)
              }
              onReject={
                onRejectQuestion
                  ? (blockId) =>
                      onRejectQuestion(activeQuestion.messageId, blockId)
                  : undefined
              }
            />
          </div>
        )}
        {activePermission && onRespondPermission && (
          <PermissionDialog
            permission={activePermission}
            onRespond={onRespondPermission}
            variant="inline"
          />
        )}
        {!composerLocked && value.trim().length > 0 && (
          <div className={cn('flex', 'items-center', 'justify-between', 'gap-2', 'px-1', 'text-[11px]', 'text-muted-foreground')}>
            <span>Draft saved for this session</span>
            <span className={cn('hidden', 'sm:inline')}>{value.trim().length} chars</span>
          </div>
        )}
        {!composerLocked && (
        <div className={cn('relative', 'overflow-visible', 'rounded-2xl', 'border', 'border-border/50', 'bg-background', 'shadow-sm')}>
            <>
            {visibleSlashItems.length > 0 && (
              <div className={cn('absolute', 'bottom-full', 'left-4', 'right-4', 'z-20', 'mb-2')}>
                <div className={cn('max-h-72', 'overflow-y-auto', 'rounded-xl', 'border', 'border-border/60', 'bg-background/95', 'p-1', 'shadow-lg', 'backdrop-blur', 'supports-[backdrop-filter]:bg-background/85')}>
                  {filteredWorkflowItems.length > 0 && (
                    <div className={cn('px-2', 'pb-1', 'pt-1', 'text-[10px]', 'font-medium', 'uppercase', 'tracking-[0.14em]', 'text-muted-foreground')}>
                      Workflow Shortcuts
                    </div>
                  )}
                  {filteredWorkflowItems.map((skill, index) => {
                    return (
                      <button
                        key={skill.name}
                        ref={(node) => {
                          slashItemRefs.current[index] = node;
                        }}
                        type="button"
                        onClick={() => insertSkill(skill.name)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                          index === selectedSkillIndex
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-accent/60",
                        )}
                      >
                        <div className={cn('min-w-0', 'flex-1')}>
                          <div className="font-medium">{skill.name}</div>
                          {skill.description && (
                            <div className={cn('truncate', 'text-xs', 'text-muted-foreground')}>{skill.description}</div>
                          )}
                        </div>
                        <span className={cn('text-[11px]', 'uppercase', 'tracking-[0.14em]', 'text-muted-foreground')}>
                          Insert
                        </span>
                      </button>
                    );
                  })}
                  {filteredWorkflowItems.length > 0 && filteredCommandItems.length > 0 && (
                    <div className={cn('mx-2', 'my-1', 'h-px', 'bg-border/60')} />
                  )}
                  {filteredCommandItems.length > 0 && (
                    <div className={cn('px-2', 'pb-1', 'pt-1', 'text-[10px]', 'font-medium', 'uppercase', 'tracking-[0.14em]', 'text-muted-foreground')}>
                      Actions
                    </div>
                  )}
                  {filteredCommandItems.map((skill, commandIndex) => {
                    const index = filteredWorkflowItems.length + commandIndex;
                    return (
                      <button
                        key={skill.name}
                        ref={(node) => {
                          slashItemRefs.current[index] = node;
                        }}
                        type="button"
                        onClick={() => insertSkill(skill.name)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                          index === selectedSkillIndex
                            ? "bg-accent text-accent-foreground"
                            : "hover:bg-accent/60",
                        )}
                        title={skill.template || skill.description || skill.name}
                      >
                        <div className={cn('min-w-0', 'flex-1')}>
                          <div className="font-medium">{skill.name}</div>
                          {skill.description && (
                            <div className={cn('truncate', 'text-xs', 'text-muted-foreground')}>{skill.description}</div>
                          )}
                        </div>
                        <span className={cn('rounded', 'border', 'border-border/60', 'px-1.5', 'py-0.5', 'text-[10px]', 'uppercase', 'tracking-[0.14em]', 'text-muted-foreground')}>
                          Command
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* File attachments */}
            {files.length > 0 && (
              <div className={cn('px-4', 'pt-3', 'pb-0', 'flex', 'flex-wrap', 'gap-2')}>
                {files.map((file) => (
                  <div
                    key={file.id}
                    className={cn('group', 'relative', 'overflow-hidden', 'rounded-lg', 'border', 'border-border/60', 'bg-muted/20')}
                  >
                    <img src={file.url} alt={file.filename} className={cn('h-16', 'w-16', 'object-cover')} />
                    <button
                      type="button"
                      onClick={() => setFiles((c) => c.filter((f) => f.id !== file.id))}
                      className={cn('absolute', 'right-1', 'top-1', 'rounded-full', 'bg-background/90', 'px-1.5', 'py-0.5', 'text-[10px]', 'text-foreground', 'opacity-0', 'shadow', 'transition-opacity', 'group-hover:opacity-100')}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {!imageUploadSupported && (
                  <div className={cn('w-full', 'rounded-lg', 'border', 'border-amber-500/30', 'bg-amber-500/10', 'px-3', 'py-1.5', 'text-xs', 'text-amber-700', 'dark:text-amber-300')}>
                    Current model does not support image input.
                  </div>
                )}
              </div>
            )}

            {/* Textarea */}
            <div className={cn('relative', 'px-4', 'pt-3', 'pb-2')}>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onCompositionStart={() => { isComposingRef.current = true; }}
                onCompositionEnd={(event) => {
                  isComposingRef.current = false;
                  setValue(event.currentTarget.value);
                }}
                onPaste={handlePaste}
                onKeyDown={handleKeyDown}
                placeholder="Send a message..."
                rows={1}
                disabled={disabled || questionPending || permissionPending}
                className={cn(
                  "min-h-[40px] max-h-[240px] w-full resize-none bg-transparent py-1 text-[15px] leading-6 outline-none placeholder:text-muted-foreground",
                  (disabled || questionPending || permissionPending) && "cursor-not-allowed opacity-60",
                )}
              />
            </div>

            {/* Toolbar */}
			<div className={cn('flex', 'flex-wrap', 'items-center', 'gap-2', 'border-t', 'border-border/40', 'px-3', 'py-2')}>
              {/* Left: Task, Doc, Image */}
				<div className={cn('flex', 'min-w-0', 'items-center', 'gap-0.5')}>
                <Popover open={referencePopupOpen} onOpenChange={(open) => {
                  if (!open) { setReferencePopupOpen(false); setSearchQuery(""); }
                  else { openSearchPopup(); }
                }}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" disabled={disabled || isStreaming}
                      className={cn('h-7', 'gap-1', 'rounded-lg', 'px-2', 'text-xs', 'text-muted-foreground', 'hover:text-foreground')}
                      title="Reference a task or doc">
                      <Tag className={cn('h-3.5', 'w-3.5')} />
                      <span className={cn('hidden', 'sm:inline')}>Task</span>
                      <span className="text-muted-foreground/50">/</span>
                      <FileText className={cn('h-3.5', 'w-3.5')} />
                      <span className={cn('hidden', 'sm:inline')}>Doc</span>
                    </Button>
                  </PopoverTrigger>
					<PopoverContent side="top" align="start" className={cn('w-[min(340px,calc(100vw-2rem))]', 'rounded-xl', 'border-border/60', 'p-0', 'shadow-xl')} sideOffset={8}>
                    <div className={cn('max-h-[300px]', 'overflow-y-auto')}>
                      <div className={cn('px-1', 'py-1')}>
                        {searchResults.tasks.length > 0 && (
                          <>
                            <div className={cn('px-2', 'py-1.5', 'text-[10px]', 'font-medium', 'uppercase', 'tracking-wider', 'text-muted-foreground')}>
                              Tasks
                            </div>
                            {searchResults.tasks.map((task) => (
                              <button key={task.id} type="button" onClick={() => insertMention("task", task.id, task.title)}
                                className={cn('flex', 'w-full', 'items-center', 'gap-2', 'rounded-lg', 'px-2', 'py-1.5', 'text-sm', 'hover:bg-muted')}>
                                <Tag className={cn('h-3.5', 'w-3.5', 'shrink-0', 'text-muted-foreground')} />
                                <span className={cn('truncate', 'font-mono', 'text-xs', 'text-muted-foreground')}>@{task.id}</span>
                                <span className="truncate">{task.title}</span>
                              </button>
                            ))}
                          </>
                        )}
                        {searchResults.docs.length > 0 && (
                          <>
                            <div className={cn('px-2', 'py-1.5', 'text-[10px]', 'font-medium', 'uppercase', 'tracking-wider', 'text-muted-foreground')}>
                              Docs
                            </div>
                            {searchResults.docs.map((doc) => (
                              <button key={doc.path} type="button"
                                onClick={() => insertMention("doc", doc.path.replace(/^docs\//, "").replace(/\.md$/, ""), doc.title)}
                                className={cn('flex', 'w-full', 'items-center', 'gap-2', 'rounded-lg', 'px-2', 'py-1.5', 'text-sm', 'hover:bg-muted')}>
                                <FileText className={cn('h-3.5', 'w-3.5', 'shrink-0', 'text-muted-foreground')} />
                                <span className={cn('truncate', 'font-mono', 'text-xs', 'text-muted-foreground')}>
                                  @doc/{doc.path.replace(/\.md$/, "").replace(/^docs\//, "")}
                                </span>
                                <span className="truncate">{doc.title}</span>
                              </button>
                            ))}
                          </>
                        )}
                        {searchResults.tasks.length === 0 && searchResults.docs.length === 0 && (
                          <div className={cn('px-2', 'py-4', 'text-center', 'text-xs', 'text-muted-foreground')}>No tasks or docs found</div>
                        )}
                      </div>
                    </div>
                    <div className={cn('flex', 'items-center', 'gap-2', 'border-t', 'border-border/40', 'px-2', 'py-2')}>
                      <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search tasks & docs..." autoFocus
                        className={cn('flex-1', 'bg-transparent', 'text-sm', 'outline-none', 'placeholder:text-muted-foreground')} />
                      <button type="button" onClick={() => { setReferencePopupOpen(false); setSearchQuery(""); }} className={cn('rounded', 'p-0.5', 'hover:bg-muted')}>
                        <X className={cn('h-3.5', 'w-3.5', 'text-muted-foreground')} />
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>

                <Button type="button" variant="ghost" size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled || isStreaming || !imageUploadSupported}
                  className={cn('h-7', 'w-7', 'rounded-lg', 'p-0', 'text-muted-foreground', 'hover:text-foreground')}
                  title={imageUploadSupported ? "Add image" : "Model does not support images"}>
                  <Plus className={cn('h-3.5', 'w-3.5')} />
                </Button>
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleSelectFiles} />
              </div>

              {/* Middle: Model selector */}
				<div className={cn('flex', 'min-w-0', 'flex-1', 'items-center', 'gap-1', 'sm:ml-1', 'sm:flex-none')}>
				  <Button type="button" variant="ghost" size="sm"
				    onClick={() => setMobileControlsOpen(true)}
				    className={cn('h-7', 'rounded-lg', 'px-2', 'text-xs', 'text-muted-foreground', 'hover:text-foreground', 'sm:hidden')}
				    title="Open chat controls">
				    <SlidersHorizontal className={cn('mr-1', 'h-3.5', 'w-3.5')} />
				    Controls
				  </Button>
                <Popover open={modelOpen} onOpenChange={setModelOpen}>
                  <PopoverTrigger asChild>
					<Button variant="ghost" role="combobox" aria-expanded={modelOpen}
					  className={cn('hidden', 'h-7', 'min-w-0', 'max-w-[120px]', 'flex-1', 'justify-between', 'gap-1.5', 'rounded-lg', 'px-2', 'text-xs', 'font-medium', 'text-muted-foreground', 'hover:text-foreground', 'sm:inline-flex', 'sm:max-w-[200px]', 'sm:flex-none')}>
                      <span className="truncate">{selectedModel ? selectedModel.modelName : autoModelLabel}</span>
                      <ChevronsUpDown className={cn('h-3', 'w-3', 'shrink-0', 'opacity-50')} />
                    </Button>
                  </PopoverTrigger>
					<PopoverContent className={cn('w-[min(420px,calc(100vw-2rem))]', 'rounded-2xl', 'border-border/60', 'p-0', 'shadow-xl')} align="start">
                    <Command>
                      <CommandInput placeholder="Search model..." value={modelQuery} onValueChange={setModelQuery} />
                      <CommandList>
                        <CommandEmpty>No models found.</CommandEmpty>
                        <CommandGroup heading="Selection">
                          <CommandItem value="auto" onSelect={() => { onModelChange(null); setModelOpen(false); setModelQuery(""); }}>
                            <Check className={cn("mr-2 h-4 w-4", !currentModel ? "opacity-100" : "opacity-0")} />
                            <div className={cn('flex', 'min-w-0', 'flex-1', 'items-center', 'gap-2')}>
                              <span className="truncate">{autoModelLabel}</span>
                              <Badge variant="outline" className="text-[10px]">Default</Badge>
                            </div>
                          </CommandItem>
                        </CommandGroup>
                        <CommandSeparator />
                        {providers.map((provider) => (
                          <CommandGroup key={provider.id} heading={provider.name}>
                            {provider.models.map((model) => (
                              <CommandItem key={model.key} value={`${model.modelName} ${model.providerName} ${model.key}`}
                                disabled={!model.selectable}
                                onSelect={() => { onModelChange(model.key, model.variants ? null : undefined); setModelOpen(false); setModelQuery(""); }}>
                                <Check className={cn("mr-2 h-4 w-4", currentModel === model.key ? "opacity-100" : "opacity-0")} />
                                <div className={cn('flex', 'min-w-0', 'flex-1', 'items-center', 'gap-2')}>
                                  <span className="truncate">{model.modelName}</span>
                                  {model.apiDefault && <Badge variant="outline" className="text-[10px]">API Default</Badge>}
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        ))}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                
                {hasVariants && (
                  <Popover open={variantOpen} onOpenChange={setVariantOpen}>
                    <PopoverTrigger asChild>
					<Button variant="ghost" role="combobox" aria-expanded={variantOpen}
					  className={cn('hidden', 'h-7', 'min-w-0', 'max-w-[84px]', 'justify-between', 'gap-1', 'rounded-lg', 'px-2', 'text-xs', 'font-medium', 'text-muted-foreground', 'hover:text-foreground', 'sm:inline-flex', 'sm:max-w-[90px]')}>
                        <span className={cn('truncate', 'capitalize')}>{currentVariant || "Auto"}</span>
                        <ChevronsUpDown className={cn('h-3', 'w-3', 'shrink-0', 'opacity-50')} />
                      </Button>
                    </PopoverTrigger>
					<PopoverContent className={cn('w-[min(130px,calc(100vw-2rem))]', 'rounded-xl', 'border-border/60', 'p-1', 'shadow-xl')} align="start">
                      <div className="space-y-0.5">
						<button type="button" onClick={() => { onModelChange(currentModel ?? null, null); if (currentModel) onSetDefaultVariant?.(currentModel, null); setVariantOpen(false); }}
                          className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted", !currentVariant && "bg-muted font-medium")}>
                          Auto
                        </button>
                        {modelVariants.map((variant) => (
							<button key={variant} type="button"
								onClick={() => { onModelChange(currentModel ?? null, variant); if (currentModel) onSetDefaultVariant?.(currentModel, variant); setVariantOpen(false); }}
                            className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm capitalize hover:bg-muted", currentVariant === variant && "bg-muted font-medium")}>
                            {variant}
                          </button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                )}

                <OpenCodeModelManagerDialog
                  catalog={catalog}
                  lastLoadedAt={lastLoadedAt}
                  onSetDefaultModel={onSetDefaultModel}
                  onUpdateModelPref={onUpdateModelPref}
                  onToggleProviderHidden={onToggleProviderHidden}
                  showProviderVisibility={Boolean(onToggleProviderHidden)}
                  triggerIcon={<SlidersHorizontal className={cn('h-3.5', 'w-3.5')} />}
                  triggerClassName="hidden sm:inline-flex"
                />

                <div className="hidden sm:block">
                  <ContextUsageIndicator data={contextUsage} modelName={sessionModelName} messages={messages} />
                </div>
              </div>

              {/* Right: Send / Stop */}
				<div className={cn('ml-auto', 'flex', 'shrink-0', 'items-center', 'gap-2', 'self-end', 'sm:self-auto')}>
                {queueCount > 0 && (
                  <div className={cn('flex', 'h-5', 'min-w-[20px]', 'items-center', 'justify-center', 'rounded-full', 'bg-blue-500', 'px-1.5', 'text-[11px]', 'font-medium', 'text-white')}>
                    {queueCount}
                  </div>
                )}
                {isStreaming ? (
                  <Button type="button" onClick={onStop} variant="secondary" size="sm"
                    className={cn('h-7', 'w-7', 'rounded-lg', 'p-0', 'border', 'border-border/50')} title="Stop">
                    <Square className={cn('h-3.5', 'w-3.5')} />
                  </Button>
                ) : (
                  <Button type="button" onClick={submit}
                    disabled={(!value.trim() && files.length === 0) || disabled || questionPending || permissionPending || (files.length > 0 && !imageUploadSupported)}
                    size="sm" className={cn('h-7', 'w-7', 'rounded-lg', 'p-0', 'bg-foreground', 'text-background', 'hover:bg-foreground/90')} title="Send">
                    <Send className={cn('h-3.5', 'w-3.5')} />
                  </Button>
                )}
              </div>
            </div>
            <Sheet open={mobileControlsOpen} onOpenChange={setMobileControlsOpen}>
              <SheetContent side="bottom" className="rounded-t-3xl border-border/70 bg-background p-0 sm:hidden">
                <div className="space-y-4 p-4">
                  <div>
                    <div className="text-sm font-semibold text-foreground">Chat controls</div>
                    <div className="text-xs text-muted-foreground">Model, context, and session tools for compact layouts</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Popover open={modelOpen} onOpenChange={setModelOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" role="combobox" aria-expanded={modelOpen} className="min-w-0 flex-1 justify-between text-xs">
                          <span className="truncate">{selectedModel ? selectedModel.modelName : autoModelLabel}</span>
                          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className={cn('w-[min(420px,calc(100vw-2rem))]', 'rounded-2xl', 'border-border/60', 'p-0', 'shadow-xl')} align="start">
                        <Command>
                          <CommandInput placeholder="Search model..." value={modelQuery} onValueChange={setModelQuery} />
                          <CommandList>
                            <CommandEmpty>No models found.</CommandEmpty>
                            <CommandGroup heading="Selection">
                              <CommandItem value="auto-mobile" onSelect={() => { onModelChange(null); setModelOpen(false); setModelQuery(""); }}>
                                <Check className={cn("mr-2 h-4 w-4", !currentModel ? "opacity-100" : "opacity-0")} />
                                <div className={cn('flex', 'min-w-0', 'flex-1', 'items-center', 'gap-2')}>
                                  <span className="truncate">{autoModelLabel}</span>
                                  <Badge variant="outline" className="text-[10px]">Default</Badge>
                                </div>
                              </CommandItem>
                            </CommandGroup>
                            <CommandSeparator />
                            {providers.map((provider) => (
                              <CommandGroup key={`${provider.id}-mobile`} heading={provider.name}>
                                {provider.models.map((model) => (
                                  <CommandItem key={`${model.key}-mobile`} value={`${model.modelName} ${model.providerName} ${model.key}`} disabled={!model.selectable} onSelect={() => { onModelChange(model.key, model.variants ? null : undefined); setModelOpen(false); setModelQuery(""); }}>
                                    <Check className={cn("mr-2 h-4 w-4", currentModel === model.key ? "opacity-100" : "opacity-0")} />
                                    <div className={cn('flex', 'min-w-0', 'flex-1', 'items-center', 'gap-2')}>
                                      <span className="truncate">{model.modelName}</span>
                                      {model.apiDefault && <Badge variant="outline" className="text-[10px]">API Default</Badge>}
                                    </div>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            ))}
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    {hasVariants && (
                      <Popover open={variantOpen} onOpenChange={setVariantOpen}>
                        <PopoverTrigger asChild>
                          <Button variant="outline" role="combobox" aria-expanded={variantOpen} className="justify-between text-xs">
                            <span className="truncate capitalize">{currentVariant || "Auto"}</span>
                            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className={cn('w-[min(130px,calc(100vw-2rem))]', 'rounded-xl', 'border-border/60', 'p-1', 'shadow-xl')} align="start">
                          <div className="space-y-0.5">
                            <button type="button" onClick={() => { onModelChange(currentModel ?? null, null); if (currentModel) onSetDefaultVariant?.(currentModel, null); setVariantOpen(false); }} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-muted", !currentVariant && "bg-muted font-medium")}>
                              Auto
                            </button>
                            {modelVariants.map((variant) => (
                              <button key={`${variant}-mobile`} type="button" onClick={() => { onModelChange(currentModel ?? null, variant); if (currentModel) onSetDefaultVariant?.(currentModel, variant); setVariantOpen(false); }} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm capitalize hover:bg-muted", currentVariant === variant && "bg-muted font-medium")}>
                                {variant}
                              </button>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                  <div className="rounded-2xl border border-border/60 bg-muted/20 p-3">
                    <ContextUsageIndicator data={contextUsage} modelName={sessionModelName} messages={messages} />
                  </div>
                  <OpenCodeModelManagerDialog
                    catalog={catalog}
                    lastLoadedAt={lastLoadedAt}
                    onSetDefaultModel={onSetDefaultModel}
                    onUpdateModelPref={onUpdateModelPref}
                    onToggleProviderHidden={onToggleProviderHidden}
                    showProviderVisibility={Boolean(onToggleProviderHidden)}
                    triggerLabel="Manage models"
                    triggerIcon={<SlidersHorizontal className={cn('h-3.5', 'w-3.5')} />}
                    triggerClassName="w-full justify-center"
                  />
                </div>
              </SheetContent>
            </Sheet>
            </>
        </div>
        )}
      </div>
    </div>
  );
}
