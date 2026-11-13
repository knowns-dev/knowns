"use client";
/** @registry name="dropdown" type="ui" title="Dropdown" description="Ready-made menus on Menu: account, row actions and pickers with avatar, toggle, link and badge rows." */

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";
import { Avatar, type AvatarStatus } from "./avatar";
import { Badge } from "./badge";
import { Button, type ButtonProps } from "./button";
import { Menu, MenuSwitch, isSections, itemText, type MenuItem, type MenuProps, type MenuSection, type MenuSelectEvent } from "./menu";
import { Tooltip } from "./tooltip";

/* ── Items ── */

interface DropdownItemBase extends Omit<MenuItem, "kind" | "checked" | "items" | "href" | "target"> {
  /** Leading avatar, shown instead of `icon`. */
  avatar?: { label: string; src?: string; icon?: ReactNode };
  /** Right-aligned extra, e.g. <Badge>New</Badge> or a count. A string or number becomes a small Badge. */
  badge?: ReactNode;
  /** Nested rows: opens a submenu. */
  items?: DropdownItem[] | DropdownSection[];
}
export interface DropdownActionItem extends DropdownItemBase {
  kind?: "item" | "radio" | "checkbox";
  checked?: boolean;
}
export interface DropdownLinkItem extends DropdownItemBase {
  kind: "link";
  href: string;
  /** Opens in a new tab (noopener) and shows ↗. */
  external?: boolean;
}
export interface DropdownToggleItem extends DropdownItemBase {
  kind: "toggle";
  /** On / off. A menuitemcheckbox drawn as a switch; the menu stays open while toggling. */
  checked: boolean;
}
export type DropdownItem = DropdownActionItem | DropdownLinkItem | DropdownToggleItem;
export interface DropdownSection {
  id: string;
  label?: string;
  items: DropdownItem[];
}

const ExternalGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5 flex-none text-muted-foreground">
    <path d="M5.5 10.5l5-5M6.5 5.5h4v4" />
  </svg>
);

/** @deprecated Use MenuSwitch from ./menu. */
export const DropdownSwitchGlyph = MenuSwitch;

/** Maps a Dropdown row onto Menu's MenuItem (links → href, toggles → kind "switch", badge / ↗ → trailing). Exported for tests. */
export function toMenuItem(item: DropdownItem): MenuItem {
  const { avatar, badge, kind, items, href, external, ...rest } = item as DropdownItem & { href?: string; external?: boolean };
  const hasBadge = badge !== undefined && badge !== null && badge !== false;
  const link = kind === "link";
  const trailing =
    hasBadge || (link && external) ? (
      <span className="flex items-center gap-2">
        {link && external && <ExternalGlyph />}
        {hasBadge && (typeof badge === "string" || typeof badge === "number" ? <Badge tone="accent" className="h-5">{badge}</Badge> : badge)}
      </span>
    ) : undefined;
  return {
    ...rest,
    kind: kind === "toggle" ? "switch" : link ? "item" : kind,
    href: link ? href : undefined,
    target: link && external ? "_blank" : undefined,
    textValue: itemText(item) || undefined,
    icon: avatar ? <Avatar size="xs" decorative label={avatar.label} src={avatar.src} icon={avatar.icon} className="-mx-0.5" /> : item.icon,
    trailing: trailing ?? rest.trailing,
    items: items ? toMenuItems(items) : undefined,
  };
}

/** Maps a whole list (flat or sections), recursively. */
export function toMenuItems(items: DropdownItem[] | DropdownSection[]): MenuItem[] | MenuSection[] {
  return isSections(items as MenuItem[] | MenuSection[])
    ? (items as DropdownSection[]).map((s) => ({ id: s.id, label: s.label, items: s.items.map(toMenuItem) }))
    : (items as DropdownItem[]).map(toMenuItem);
}

function index(items: DropdownItem[] | DropdownSection[], into = new Map<string, DropdownItem>()) {
  const rows = isSections(items as MenuItem[] | MenuSection[]) ? (items as DropdownSection[]).flatMap((s) => s.items) : (items as DropdownItem[]);
  for (const it of rows) {
    into.set(it.id, it);
    if (it.items) index(it.items, into);
  }
  return into;
}

export interface DropdownProps extends Omit<MenuProps, "items" | "onSelect" | "role"> {
  items: DropdownItem[] | DropdownSection[];
  /** Called with the original row. For links, event.preventDefault() cancels the navigation. */
  onSelect?: (item: DropdownItem, event: MenuSelectEvent) => void;
}

/**
 * An action menu built on Menu, with extra row kinds: links (real <a>, ↗ for new tabs), toggles
 * (a switch that keeps the menu open), leading avatars, trailing badges and submenus. Keyboard, focus,
 * typeahead and positioning are Menu's.
 */
export function Dropdown({ items, onSelect, ...menu }: DropdownProps) {
  const byId = index(items);
  return (
    <Menu
      {...menu}
      items={toMenuItems(items)}
      onSelect={(picked, event) => {
        const item = byId.get(picked.id);
        if (item) onSelect?.(item, event);
      }}
    />
  );
}

/* ── Triggers ── */

const Chevron = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={cn("transition-[rotate] duration-[var(--kn-dur-fast,120ms)] ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))] in-aria-expanded:rotate-180 motion-reduce:transition-none", className)}
  >
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </svg>
);

const Dots = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </svg>
);

export interface DropdownButtonProps extends Omit<ButtonProps, "children" | "iconRight"> {
  label: ReactNode;
}

const ICON_BOX = { xs: "size-3.5", sm: "size-3.5", md: "size-4", lg: "size-[17px]" } as const;

/** A Button with a chevron that turns while the menu is open. Pass as `trigger`. */
export function DropdownButton({ label, variant = "secondary", size = "md", icon, ...rest }: DropdownButtonProps) {
  // Box the icon so non-svg glyphs (e.g. modelIcon's wrapper span) get the same size as svgs.
  const boxed = icon ? <span className={cn("grid flex-none place-items-center [&>*]:size-full", ICON_BOX[size])}>{icon}</span> : undefined;
  return (
    <Button variant={variant} size={size} icon={boxed} iconRight={<Chevron className="-mr-1 text-muted-foreground" />} {...rest}>
      {label}
    </Button>
  );
}

export interface DropdownIconButtonProps extends Omit<ButtonProps, "children" | "iconRight"> {
  "aria-label": string;
  /** Tooltip text. Default: the aria-label. Pass null for none. */
  tooltip?: ReactNode;
}

/** Icon-only "more" (⋯) trigger with a tooltip. Pass as `trigger`. */
export function DropdownIconButton({ icon, tooltip, variant = "ghost", ...rest }: DropdownIconButtonProps) {
  const button = <Button variant={variant} icon={icon ?? <Dots />} {...rest} />;
  if (tooltip === null) return button;
  return <Tooltip content={tooltip ?? rest["aria-label"]}>{button}</Tooltip>;
}

export interface DropdownAvatarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Person's name: the avatar's initials and the button's name. */
  name: string;
  email?: string;
  src?: string;
  /** Glyph instead of initials. */
  avatarIcon?: ReactNode;
  status?: AvatarStatus;
  /** Avatar and chevron only; the name becomes the aria-label. */
  compact?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** Account trigger: avatar, optional name and email, chevron. Pass as `trigger`. */
export function DropdownAvatarButton({ name, email, src, avatarIcon, status, compact, className, type = "button", ...rest }: DropdownAvatarButtonProps) {
  return (
    <button
      type={type}
      aria-label={compact ? name : undefined}
      {...rest}
      className={cn(
        "group inline-flex max-w-full flex-none cursor-pointer items-center gap-2.5 rounded-[12px] p-1 pr-2 text-left select-none",
        "transition-[background-color,box-shadow] duration-[var(--kn-dur-fast,120ms)] ease-[var(--kn-ease-out,cubic-bezier(.22,1,.36,1))]",
        "hover:bg-[color-mix(in_srgb,var(--muted)_70%,transparent)] aria-expanded:bg-[color-mix(in_srgb,var(--muted)_70%,transparent)]",
        "disabled:pointer-events-none disabled:opacity-45",
        focusRing,
        className,
      )}
    >
      <Avatar label={name} src={src} icon={avatarIcon} status={status} size={email && !compact ? "md" : "sm"} shape="circle" decorative={!compact && !status} />
      {!compact && (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
          {email && <span className="truncate text-[12px] text-muted-foreground">{email}</span>}
        </span>
      )}
      <Chevron className="size-3.5 flex-none text-muted-foreground" />
    </button>
  );
}

/* ── Header ── */

export interface DropdownHeaderProps {
  name: string;
  email?: string;
  src?: string;
  icon?: ReactNode;
  status?: AvatarStatus;
  /** A plan or role. Strings render as a small Badge. */
  plan?: ReactNode;
  className?: string;
}

/** User card for the `header` slot. */
export function DropdownHeader({ name, email, src, icon, status, plan, className }: DropdownHeaderProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3 py-0.5", className)}>
      <Avatar label={name} src={src} icon={icon} status={status} size="md" shape="circle" decorative={!status} />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
        {email && <span className="truncate text-[12px] text-muted-foreground">{email}</span>}
      </div>
      {plan !== undefined && plan !== null && (typeof plan === "string" ? <Badge tone="accent">{plan}</Badge> : plan)}
    </div>
  );
}

export default Dropdown;
