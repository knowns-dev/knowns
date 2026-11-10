"use client";
/** @registry name="page-header" type="block" title="Page header" description="Page header for a project, record or agent run: breadcrumbs, title and status, meta, progress, tabs and actions that fold into a menu by width, condensing into a sticky bar on scroll." */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/ui/lib/knowns/utils";
import { formatUsd } from "@/ui/lib/knowns/status";
import { modelIcon } from "@/ui/lib/knowns/icons/model-icons";
import { useAgentSnapshot, type AgentRun } from "@/ui/lib/knowns/run";
import { Avatar, AvatarGroup } from "../avatar";
import { Badge, type BadgeTone } from "../badge";
import { Button } from "../button";
import { DropdownIconButton } from "../dropdown";
import { Menu, type MenuItem } from "../menu";
import { Progress } from "../progress";
import { Tabs, TabsList, TabsTrigger } from "../tabs";
import { Tooltip } from "../tooltip";
import { fitActions, formatDue, formatProgress, headerLayout, nextCondensed, runSummary, stickyTop, titleReserve } from "./page-header-utils";

export interface PageHeaderCrumb {
  label: string;
  href?: string;
}

export interface PageHeaderAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Run the action. Return a short result (e.g. "Following") to announce it politely. */
  onSelect?: () => void | string | Promise<void | string>;
  danger?: boolean;
  disabled?: boolean;
  /** In the overflow menu: a submenu of these (e.g. "Move to ›" columns). */
  items?: PageHeaderAction[];
}

export interface PageHeaderTab {
  value: string;
  label: ReactNode;
  count?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PageHeaderPerson {
  label: string;
  src?: string;
  icon?: ReactNode;
}

export interface PageHeaderMeta {
  id: string;
  /** Small muted label before the value, e.g. "Owner". */
  label?: string;
  icon?: ReactNode;
  content: ReactNode;
}

export interface PageHeaderProps {
  breadcrumbs?: PageHeaderCrumb[];
  /** Accessible name of the breadcrumb landmark. Default "Breadcrumb: <title>", so several headers on one page stay distinct. */
  breadcrumbLabel?: string;
  title: ReactNode;
  /** Text of the title for the compact bar's tooltip and the page's accessible name, when `title` isn't plain text. */
  titleText?: string;
  status?: { label: string; tone?: BadgeTone; dot?: boolean };
  description?: ReactNode;
  owner?: PageHeaderPerson;
  members?: PageHeaderPerson[];
  /** Members shown before "+N". Default 4. */
  membersMax?: number;
  /** Target date. */
  due?: Date | string | number;
  /** Any other items for the meta row. */
  meta?: PageHeaderMeta[];
  /** "31 of 40 issues · 78%" with a thin bar. */
  progress?: { value: number; total: number; unit?: string; label?: string };
  tabs?: PageHeaderTab[];
  tab?: string;
  defaultTab?: string;
  onTabChange?: (value: string) => void;
  /** The main action. Give it an icon: below ~460px it shows only the icon. */
  primaryAction?: PageHeaderAction;
  /** Secondary actions. They move into the overflow menu, last first, when the row runs out of room. */
  actions?: PageHeaderAction[];
  /** Actions that always live in the overflow menu ("More actions"). */
  moreActions?: PageHeaderAction[];
  /** Condense into a compact sticky bar after a little scroll. Default true. */
  condense?: boolean;
  /** The scrolling element. Default: the window. */
  scrollContainer?: RefObject<HTMLElement | null>;
  /**
   * Page content. With tabs, put your <TabsContent value="…"> panels here so they are wired to the tabs.
   * The header sticks while this content scrolls.
   */
  children?: ReactNode;
  /** "run": status, spend, agents and Pause / Stop / Share from a live AgentRun. */
  /** "stacked" (default): breadcrumbs above, actions next to the title. "inline": breadcrumbs and actions share the top row. */
  layout?: "stacked" | "inline";
  /** Extra node at the end of the action row (e.g. a sheet's close button). */
  trailing?: ReactNode;
  /** "lg": a large title (about 36px), for detail pages. Default "md". */
  size?: "md" | "lg";
  variant?: "default" | "run";
  run?: AgentRun;
  /** Variant "run": show the run's spend in the meta row. Default true. Turn off when the page shows spend elsewhere (a budget card). */
  spend?: boolean;
  paused?: boolean;
  onPause?: () => void | string;
  onResume?: () => void | string;
  onStop?: () => void | string;
  onShare?: () => void | string;
  className?: string;
}

/* ── Glyphs ── */

const g = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const Calendar = () => (
  <svg {...g}>
    <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </svg>
);
const Coin = () => (
  <svg {...g}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M9.75 6.25C9.5 5.6 8.85 5.25 8 5.25c-1.1 0-1.75.55-1.75 1.3 0 1.8 3.5.9 3.5 2.75 0 .8-.75 1.45-1.75 1.45-.9 0-1.6-.4-1.85-1.1M8 4.25v1M8 10.75v1" />
  </svg>
);
const Pause = () => (
  <svg {...g}>
    <path d="M6 4v8M10 4v8" />
  </svg>
);
const Play = () => (
  <svg {...g}>
    <path d="M5.5 3.75v8.5L12 8 5.5 3.75Z" />
  </svg>
);
const Square = () => (
  <svg {...g}>
    <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.5" />
  </svg>
);
const Share = () => (
  <svg {...g}>
    <path d="M8 10V2.5M5 5.25 8 2.25l3 3M3.5 8.5v4c0 .55.45 1 1 1h7c.55 0 1-.45 1-1v-4" />
  </svg>
);
const Slash = () => (
  <svg {...g} className="size-3 flex-none text-muted-foreground/50">
    <path d="M10 3 6 13" />
  </svg>
);

const isoDate = (d: Date | string | number) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10);
};

/* ── Hooks ── */

function useWidth(ref: RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/* ── Pieces ── */

function Crumbs({ items, hideRoot, label }: { items: PageHeaderCrumb[]; hideRoot: boolean; label: string }) {
  const shown = hideRoot && items.length > 1 ? items.slice(1) : items;
  return (
    <nav aria-label={label} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
        {hideRoot && items.length > 1 && (
          <li aria-hidden className="flex-none">
            …
          </li>
        )}
        {shown.map((c, i) => {
          const last = i === shown.length - 1;
          return (
            <Fragment key={`${c.label}-${i}`}>
              {(i > 0 || (hideRoot && items.length > 1)) && (
                <li aria-hidden className="flex flex-none items-center">
                  <Slash />
                </li>
              )}
              <li className={cn("min-w-0", last ? "truncate" : "flex-none")}>
                {last ? (
                  <span aria-current="page" className="truncate text-foreground/80">
                    {c.label}
                  </span>
                ) : c.href ? (
                  <a href={c.href} className="rounded-sm transition-colors duration-150 hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    {c.label}
                  </a>
                ) : (
                  <span>{c.label}</span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

function MetaItem({ label, icon, children }: { label?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      {icon && <span className="grid size-3.5 flex-none place-items-center text-muted-foreground [&>*]:size-full">{icon}</span>}
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className="min-w-0 truncate text-foreground/85">{children}</span>
    </li>
  );
}

/* ── Component ── */

/**
 * The top of a page: breadcrumbs, title and status, description, a meta row (owner, members, due date…),
 * progress, actions and tabs. Responds to its container's width, and after a little scroll folds into a
 * compact sticky bar (title, status, primary action) above the tabs.
 */
export function PageHeader(props: PageHeaderProps) {
  const p = useRunProps(props);
  const {
    breadcrumbs,
    breadcrumbLabel,
    title,
    titleText,
    status,
    description,
    owner,
    members,
    membersMax = 4,
    due,
    meta,
    progress,
    tabs,
    tab,
    defaultTab,
    onTabChange,
    primaryAction,
    actions = [],
    moreActions = [],
    condense = true,
    scrollContainer,
    children,
    layout = "stacked",
    trailing,
    size = "md",
    className,
  } = p;
  const inline = layout === "inline";
  const plainTitle = titleText ?? (typeof title === "string" ? title : undefined);
  const crumbLabel = breadcrumbLabel ?? (plainTitle ? `Breadcrumb: ${plainTitle}` : "Breadcrumb");

  const root = useRef<HTMLElement>(null);
  const width = useWidth(root);
  const { hideRootCrumb, iconOnlyPrimary } = headerLayout(width);

  /* Live result of actions. */
  const [said, setSaid] = useState({ text: "", n: 0 });
  const runAction = useCallback(async (a: PageHeaderAction) => {
    const r = await a.onSelect?.();
    if (typeof r === "string" && r) setSaid((s) => ({ text: r, n: s.n + 1 }));
  }, []);

  /* Secondary actions: measure each once in a hidden row, then keep as many as fit. */
  const ghost = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<{ actions: number[]; primary: number }>({ actions: [], primary: 0 });
  const key = actions.map((a) => a.id + a.label).join("|") + "#" + (primaryAction?.label ?? "");
  useLayoutEffect(() => {
    const el = ghost.current;
    if (!el) return;
    const btns = [...el.querySelectorAll<HTMLElement>("[data-measure]")];
    setWidths({
      actions: btns.filter((b) => b.dataset.measure === "action").map((b) => Math.ceil(b.getBoundingClientRect().width)),
      primary: Math.ceil(btns.find((b) => b.dataset.measure === "primary")?.getBoundingClientRect().width ?? 0),
    });
  }, [key]);
  const GAP = 8;
  const MORE = 32;
  const primaryW = primaryAction ? (iconOnlyPrimary ? 32 : widths.primary) + GAP : 0;
  const available = width > 0 ? width - titleReserve(width) - primaryW - (trailing ? 32 + GAP : 0) : Infinity;
  const fitting = width > 0 && widths.actions.length === actions.length ? fitActions(widths.actions, available, GAP, MORE) : actions.length;
  const visible = actions.slice(0, fitting);
  const folded = [...actions.slice(fitting), ...moreActions];

  /* Condense on scroll. */
  const [condensed, setCondensed] = useState(false);
  const condensedRef = useRef(false);
  const tabsRow = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState({ top: 0, tabs: 0 });
  const COMPACT = 52;
  useLayoutEffect(() => {
    if (!condense) return;
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const tabsH = tabsRow.current?.offsetHeight ?? 0;
      const next = { top: stickyTop(el.offsetHeight, COMPACT, tabsH), tabs: tabsH };
      setStick((s) => (s.top === next.top && s.tabs === next.tabs ? s : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [condense]);
  useEffect(() => {
    if (!condense) return;
    const target: HTMLElement | Window = scrollContainer?.current ?? window;
    const marker = sentinel.current;
    let raf = 0;
    const check = () => {
      raf = 0;
      if (!marker) return;
      const edge = target instanceof Window ? 0 : target.getBoundingClientRect().top;
      // The sentinel sits where the header starts in the flow; how far it went past the edge is the scroll.
      const next = nextCondensed(condensedRef.current, edge - marker.getBoundingClientRect().top);
      if (next !== condensedRef.current) {
        condensedRef.current = next;
        setCondensed(next);
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [condense, scrollContainer]);
  const sentinel = useRef<HTMLDivElement>(null);

  const titleString = titleText ?? (typeof title === "string" ? title : undefined);
  const statusBadge = status && (
    <Badge tone={status.tone ?? "neutral"} dot={status.dot ?? true} shape="pill" className="flex-none">
      {status.label}
    </Badge>
  );

  const primaryButton = (compact: boolean) =>
    primaryAction &&
    (compact || iconOnlyPrimary ? (
      <Tooltip content={primaryAction.label}>
        <Button
          icon={primaryAction.icon}
          aria-label={primaryAction.label}
          disabled={primaryAction.disabled}
          variant={primaryAction.danger ? "destructive" : "primary"}
          size={compact ? "sm" : "md"}
          onClick={() => runAction(primaryAction)}
        />
      </Tooltip>
    ) : (
      <Button icon={primaryAction.icon} disabled={primaryAction.disabled} variant={primaryAction.danger ? "destructive" : "primary"} onClick={() => runAction(primaryAction)}>
        {primaryAction.label}
      </Button>
    ));

  const toItem = (a: PageHeaderAction): MenuItem => ({ id: a.id, label: a.label, icon: a.icon, danger: a.danger, disabled: a.disabled, items: a.items?.map(toItem) });
  const menuItems: MenuItem[] = folded.map(toItem);
  const findAction = (list: PageHeaderAction[], id: string): PageHeaderAction | undefined => {
    for (const a of list) {
      if (a.id === id) return a;
      const hit = a.items && findAction(a.items, id);
      if (hit) return hit;
    }
  };

  const hasMeta = !!(owner || members?.length || due !== undefined || meta?.length);
  const tabList = tabs && tabs.length > 0 && (
    <div ref={tabsRow} className="-mx-1 px-1">
      <TabsList aria-label={titleString ? `${titleString} sections` : "Sections"}>
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value} icon={t.icon} badge={t.count} disabled={t.disabled}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );

  const titleClass =
    size === "lg"
      ? "min-w-0 text-[28px] leading-[1.12] font-semibold tracking-[-0.022em] text-balance @[560px]:text-[36px]"
      : "min-w-0 text-[22px] leading-tight font-semibold tracking-tight text-balance";
  const actionRow = (
    <div className="flex flex-none items-center gap-2">
      {visible.map((a) => (
        <Button key={a.id} variant={a.danger ? "destructive" : "secondary"} icon={a.icon} disabled={a.disabled} onClick={() => runAction(a)}>
          {a.label}
        </Button>
      ))}
      {folded.length > 0 && (
        <Menu
          aria-label="More actions"
          align="end"
          items={menuItems}
          onSelect={(item) => {
            const a = findAction(folded, item.id);
            if (a) runAction(a);
          }}
          trigger={<DropdownIconButton aria-label="More actions" variant="secondary" />}
        />
      )}
      {primaryButton(false)}
      {trailing}
    </div>
  );

  const header = (
    <>
      <div ref={sentinel} aria-hidden className="h-0" />
      <header
        ref={root}
        style={condense ? { top: stick.top } : undefined}
        className={cn("@container z-20 bg-background", condense && "sticky", className)}
      >
        <div role="status" aria-live="polite" className="sr-only">
          {said.text && <span key={said.n}>{said.text}</span>}
        </div>

        {/* Full header: fades out (stays in place) while the compact bar is shown. */}
        <div
          aria-hidden={condensed || undefined}
          inert={condensed}
          className={cn("flex flex-col gap-3 pt-1 pb-4 transition-opacity duration-200 ease-(--kn-ease-out) motion-reduce:duration-150", condensed && "opacity-0")}
        >
          {inline ? (
            <>
              <div className="flex min-h-8 items-center gap-4">
                <div className="min-w-0 flex-1">{breadcrumbs && breadcrumbs.length > 0 && <Crumbs items={breadcrumbs} hideRoot={hideRootCrumb} label={crumbLabel} />}</div>
                {actionRow}
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <h1 className={titleClass}>{title}</h1>
                  {statusBadge}
                </div>
                {description && <div className="max-w-[68ch] text-[14px] leading-relaxed text-muted-foreground">{description}</div>}
              </div>
            </>
          ) : (
            <>
              {breadcrumbs && breadcrumbs.length > 0 && <Crumbs items={breadcrumbs} hideRoot={hideRootCrumb} label={crumbLabel} />}
              <div className="flex items-start gap-4">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h1 className={titleClass}>{title}</h1>
                    {statusBadge}
                  </div>
                  {description && <div className="max-w-[68ch] text-[13.5px] leading-relaxed text-muted-foreground">{description}</div>}
                </div>
                {actionRow}
              </div>
            </>
          )}

          {(hasMeta || progress) && (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              {hasMeta && (
                <ul aria-label="Details" className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
                  {owner && (
                    <MetaItem label="Owner">
                      <span className="inline-flex items-center gap-1.5">
                        <Avatar label={owner.label} src={owner.src} icon={owner.icon} size="xs" shape="circle" decorative />
                        {owner.label}
                      </span>
                    </MetaItem>
                  )}
                  {members && members.length > 0 && (
                    <li className="flex items-center gap-2">
                      <span className="text-muted-foreground">Members</span>
                      <AvatarGroup size="sm" max={membersMax} label={`${members.length} members`}>
                        {members.map((m) => (
                          <Avatar key={m.label} label={m.label} src={m.src} icon={m.icon} />
                        ))}
                      </AvatarGroup>
                    </li>
                  )}
                  {due !== undefined && (
                    <MetaItem label="Due" icon={<Calendar />}>
                      <time dateTime={isoDate(due)}>{formatDue(due)}</time>
                    </MetaItem>
                  )}
                  {meta?.map((m) => (
                    <MetaItem key={m.id} label={m.label} icon={m.icon}>
                      {m.content}
                    </MetaItem>
                  ))}
                </ul>
              )}
              {progress && (
                <div className="flex w-full max-w-60 min-w-40 flex-col gap-1.5 @[640px]:w-60">
                  <div className="text-[12px] text-muted-foreground tabular-nums">{formatProgress(progress.value, progress.total, progress.unit)}</div>
                  <Progress
                    aria-label={progress.label ?? "Progress"}
                    value={progress.value}
                    max={progress.total}
                    valueLabel="none"
                    size="sm"
                    tone={progress.value >= progress.total ? "success" : "neutral"}
                    format={() => formatProgress(progress.value, progress.total, progress.unit)}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Compact bar, laid over the bottom of the full header right above the tabs. */}
        {condense && (
          <div
            aria-hidden={!condensed || undefined}
            inert={!condensed}
            style={{ height: COMPACT, bottom: stick.tabs }}
            className={cn(
              "absolute inset-x-0 flex items-center gap-2.5 bg-background",
              "transition-[opacity,translate] duration-200 ease-(--kn-ease-out) motion-reduce:translate-y-0 motion-reduce:duration-150",
              condensed ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0",
            )}
          >
            <span className="min-w-0 truncate text-[15px] font-semibold tracking-tight" title={titleString}>
              {title}
            </span>
            {statusBadge}
            <span className="flex-1" />
            {primaryButton(true)}
          </div>
        )}

        {tabList}

        {/* Hidden row used only to measure action widths. */}
        <div ref={ghost} aria-hidden inert className="pointer-events-none invisible absolute top-0 left-0 flex h-0 gap-2 overflow-hidden whitespace-nowrap">
          {actions.map((a) => (
            <span key={a.id} data-measure="action" className="inline-flex">
              <Button variant="secondary" icon={a.icon} tabIndex={-1}>
                {a.label}
              </Button>
            </span>
          ))}
          {primaryAction && (
            <span data-measure="primary" className="inline-flex">
              <Button icon={primaryAction.icon} tabIndex={-1}>
                {primaryAction.label}
              </Button>
            </span>
          )}
        </div>
      </header>
    </>
  );

  // The header and the content share one parent: sticky positioning is bounded by it.
  return tabs && tabs.length > 0 ? (
    <Tabs value={tab} defaultValue={defaultTab ?? tabs[0].value} onValueChange={onTabChange}>
      <div className="relative">
        {header}
        {children}
      </div>
    </Tabs>
  ) : (
    <div className="relative">
      {header}
      {children}
    </div>
  );
}

/* ── Run variant ── */

/** For variant "run": fill status, meta, members and actions from the live run (explicit props win). */
function useRunProps(props: PageHeaderProps): PageHeaderProps {
  const snap = useAgentSnapshot(props.variant === "run" ? props.run : undefined);
  if (props.variant !== "run") return props;
  const r = runSummary(snap);
  const paused = !!props.paused;
  const run: PageHeaderAction[] = [];
  if (props.onPause && !paused && r.state !== "done") run.push({ id: "pause", label: "Pause", icon: <Pause />, onSelect: props.onPause });
  if (props.onResume && paused) run.push({ id: "resume", label: "Resume", icon: <Play />, onSelect: props.onResume });
  if (props.onStop) run.push({ id: "stop", label: "Stop", icon: <Square />, onSelect: props.onStop, danger: true, disabled: r.state === "done" });
  const label = paused && r.state === "running" ? "Paused" : r.label;
  return {
    ...props,
    status: props.status ?? { label, tone: paused && r.state === "running" ? "neutral" : r.tone },
    members:
      props.members ??
      r.agents.map((a) => ({ label: a.model ? `${a.label} (${a.model})` : a.label, icon: modelIcon(a.model) ?? undefined })),
    meta: [
      ...(props.spend === false ? [] : [{ id: "spend", label: "Spend", icon: <Coin />, content: <span className="tabular-nums">{formatUsd(r.spend)}</span> }]),
      ...(r.waiting > 0 ? [{ id: "waiting", label: "Waiting on you", content: String(r.waiting) }] : []),
      ...(props.meta ?? []),
    ],
    actions: props.actions ?? run,
    primaryAction: props.primaryAction ?? (props.onShare ? { id: "share", label: "Share", icon: <Share />, onSelect: props.onShare } : undefined),
  };
}

export default PageHeader;
