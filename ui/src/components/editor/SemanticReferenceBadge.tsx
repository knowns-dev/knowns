import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Brain, FileCode, FileText, GitBranch } from "lucide-react";
import { resolveReference, type SemanticResolution } from "../../api/client";
import { navigateTo } from "../../lib/navigation";
import {
  STATUS_STYLES,
  docMentionBrokenClass,
  docMentionClass,
  decisionMentionClass,
  memoryMentionClass,
  normalizeDocPath,
  semanticFragmentClass,
  semanticRelationClass,
  taskMentionBrokenClass,
  taskMentionClass,
  templateMentionClass,
} from "./mentionUtils";

interface SemanticReferenceBadgeProps {
  rawRef: string;
  onDocLinkClick?: (path: string) => void;
  onTaskLinkClick?: (taskId: string) => void;
}

function docFragmentToQuery(fragment?: SemanticResolution["reference"]["fragment"]): string {
  if (!fragment) return "";
  if (fragment.rangeStart != null && fragment.rangeEnd != null) return `?L=${fragment.rangeStart}-${fragment.rangeEnd}`;
  if (fragment.line != null) return `?L=${fragment.line}`;
  if (fragment.heading) return `#${fragment.heading}`;
  return "";
}

function docFragmentDisplay(fragment?: SemanticResolution["reference"]["fragment"]): string {
  if (!fragment) return "";
  if (fragment.rangeStart != null && fragment.rangeEnd != null) return `:${fragment.rangeStart}-${fragment.rangeEnd}`;
  if (fragment.line != null) return `:${fragment.line}`;
  if (fragment.heading) return `#${fragment.heading}`;
  return "";
}

function docTargetBase(target: string): string {
  const fragmentMatch = target.match(/^(.*?)(:\d+(?:-\d+)?|#[^#]+)?$/);
  if (!fragmentMatch || !fragmentMatch[1]) return target;
  return fragmentMatch[1];
}

function unresolvedDisplay(rawRef: string): string {
  return rawRef.replace(/^@(?:doc\/|task[-/]|memory[-/]|decision\/|template\/)/, "");
}

export function SemanticReferenceBadge({ rawRef, onDocLinkClick, onTaskLinkClick }: SemanticReferenceBadgeProps) {
  const [resolution, setResolution] = useState<SemanticResolution | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    resolveReference(rawRef)
      .then((next) => {
        if (cancelled) return;
        setResolution(next);
        setNotFound(!next.found || !next.entity);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setResolution(null);
        setNotFound(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rawRef]);

  const relation = resolution?.reference.relation ?? "references";
  const fragmentSuffix = docFragmentDisplay(resolution?.reference.fragment);

  const badgeMeta = useMemo(() => {
    const entityType = resolution?.entity?.type ?? resolution?.reference.type;
    const target = resolution?.reference.target ?? rawRef;

    if (entityType === "task") {
      const taskId = resolution?.entity?.id ?? target;
      return {
        className: notFound ? taskMentionBrokenClass : taskMentionClass,
        icon: resolution?.entity?.status ? (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_STYLES[resolution.entity.status] || STATUS_STYLES.todo}`} />
        ) : null,
        label: loading ? `#${taskId}` : resolution?.entity?.title || `#${taskId}`,
        title: notFound ? `Task not found: ${taskId}` : resolution?.entity?.title || taskId,
        dataAttrs: { "data-task-id": taskId },
        interactive: true,
        onClick: (e: ReactMouseEvent<HTMLSpanElement>) => {
          e.preventDefault();
          e.stopPropagation();
          if (notFound) return;
          if (onTaskLinkClick) {
            onTaskLinkClick(taskId);
          } else {
            navigateTo(`/kanban/${taskId}`);
          }
        },
      };
    }

    if (entityType === "memory") {
      const memoryId = resolution?.reference.target ?? target;
      const resolvedMemoryId = resolution?.entity?.id ?? memoryId;
      return {
        className: notFound ? docMentionBrokenClass : memoryMentionClass,
        icon: <Brain className="w-3 h-3 shrink-0 opacity-60" />,
        label: loading ? unresolvedDisplay(rawRef) : resolution?.entity?.title || resolvedMemoryId,
        title: notFound ? `Memory not found: ${memoryId}` : resolution?.entity?.title || resolvedMemoryId,
        dataAttrs: { "data-memory-id": memoryId },
        interactive: true,
        onClick: (e: ReactMouseEvent<HTMLSpanElement>) => {
          e.preventDefault();
          e.stopPropagation();
          if (notFound) return;
          navigateTo("/memory");
        },
      };
    }

    if (entityType === "decision") {
      const decisionId = resolution?.entity?.id ?? target;
      return {
        className: notFound ? docMentionBrokenClass : decisionMentionClass,
        icon: <GitBranch className="w-3 h-3 shrink-0 opacity-60" />,
        label: loading ? unresolvedDisplay(rawRef) : resolution?.entity?.title || decisionId,
        title: notFound ? `Decision not found: ${decisionId}` : resolution?.entity?.title || decisionId,
        dataAttrs: { "data-decision-id": decisionId },
        interactive: false,
        onClick: (e: ReactMouseEvent<HTMLSpanElement>) => {
          e.preventDefault();
          e.stopPropagation();
          if (notFound) return;
          navigateTo(`/decisions/${decisionId}`);
        },
      };
    }

    if (entityType === "template") {
      const templateName = resolution?.entity?.id ?? target;
      return {
        className: notFound ? docMentionBrokenClass : templateMentionClass,
        icon: <FileCode className="w-3 h-3 shrink-0 opacity-60" />,
        label: loading ? unresolvedDisplay(rawRef) : resolution?.entity?.title || templateName,
        title: notFound ? `Template not found: ${templateName}` : resolution?.entity?.title || templateName,
        dataAttrs: { "data-template-name": templateName },
        interactive: false,
        onClick: (e: ReactMouseEvent<HTMLSpanElement>) => {
          e.preventDefault();
          e.stopPropagation();
          if (notFound) return;
          navigateTo("/config");
        },
      };
    }

    const docPath = normalizeDocPath(resolution?.entity?.path || docTargetBase(target));
    return {
      className: notFound ? docMentionBrokenClass : docMentionClass,
      icon: <FileText className="w-3 h-3 shrink-0 opacity-60" />,
      label: loading
        ? `${docTargetBase(unresolvedDisplay(rawRef))}`
        : `${resolution?.entity?.title || docTargetBase(target)}`,
      title: notFound ? `Document not found: ${docTargetBase(target)}` : resolution?.entity?.title || docTargetBase(target),
      dataAttrs: { "data-doc-path": docPath },
      interactive: true,
      onClick: (e: ReactMouseEvent<HTMLSpanElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (notFound) return;
        const targetPath = resolution?.entity?.path || docTargetBase(target);
        const suffix = docFragmentToQuery(resolution?.reference.fragment);
        if (onDocLinkClick) {
          onDocLinkClick(`${targetPath}${suffix}`);
        } else {
          navigateTo(`/docs/${targetPath}${suffix}`);
        }
      },
    };
  }, [fragmentSuffix, loading, notFound, onDocLinkClick, onTaskLinkClick, rawRef, relation, resolution]);

  const role = !notFound && badgeMeta.interactive ? "link" : undefined;
  const tooltip = `${badgeMeta.title} · ${relation}`;

  return (
    <span
      role={role}
      className={badgeMeta.className}
      title={tooltip}
      onClick={badgeMeta.interactive ? badgeMeta.onClick : undefined}
      {...badgeMeta.dataAttrs}
    >
      {badgeMeta.icon}
      <span className="max-w-[220px] truncate">{badgeMeta.label}</span>
      {fragmentSuffix && <span className={semanticFragmentClass}>{fragmentSuffix}</span>}
      <span className={semanticRelationClass}>{relation}</span>
    </span>
  );
}
