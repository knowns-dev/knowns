import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/ui/components/ui/knowns/button";
import { Sheet } from "@/ui/components/ui/knowns/sheet";
import { Switch } from "@/ui/components/ui/knowns/switch";
import { cn } from "@/ui/lib/utils";
import { type DashboardLayout, isDefaultLayout, WIDGETS, type WidgetId } from "./layout";

interface DashboardCustomizeProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	layout: DashboardLayout;
	isVisible: (id: WidgetId) => boolean;
	onToggle: (id: WidgetId) => void;
	onMove: (zone: "main" | "side", index: number, delta: -1 | 1) => void;
	onReset: () => void;
}

/** Show, hide and reorder Overview widgets. Saved in this browser only. */
export function DashboardCustomize({ open, onOpenChange, layout, isVisible, onToggle, onMove, onReset }: DashboardCustomizeProps) {
	return (
		<Sheet
			open={open}
			onOpenChange={onOpenChange}
			side="right"
			title="Customize overview"
			description="Choose what you see and in what order. Saved in this browser only."
			footer={
				<Button variant="ghost" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onReset} disabled={isDefaultLayout(layout)}>
					Reset to default
				</Button>
			}
		>
			<div className="space-y-5">
				<ul>
					<Row id="summary" checked={isVisible("summary")} onToggle={onToggle} />
				</ul>
				<Group title="Main column">
					{layout.main.map((id, index) => (
						<Row
							key={id}
							id={id}
							checked={isVisible(id)}
							onToggle={onToggle}
							onUp={index > 0 ? () => onMove("main", index, -1) : undefined}
							onDown={index < layout.main.length - 1 ? () => onMove("main", index, 1) : undefined}
						/>
					))}
				</Group>
				<Group title="Side column">
					{layout.side.map((id, index) => (
						<Row
							key={id}
							id={id}
							checked={isVisible(id)}
							onToggle={onToggle}
							onUp={index > 0 ? () => onMove("side", index, -1) : undefined}
							onDown={index < layout.side.length - 1 ? () => onMove("side", index, 1) : undefined}
						/>
					))}
				</Group>
				<p className="text-xs leading-5 text-muted-foreground">
					Charts on finishing pace, stuck work, time to finish, workload, growing areas and knowledge are on the Analytics tab.
				</p>
			</div>
		</Sheet>
	);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div>
			<p className="pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
			<ul className="divide-y divide-border/60">{children}</ul>
		</div>
	);
}

function Row({
	id,
	checked,
	onToggle,
	onUp,
	onDown,
}: {
	id: WidgetId;
	checked: boolean;
	onToggle: (id: WidgetId) => void;
	onUp?: () => void;
	onDown?: () => void;
}) {
	const { label, hint } = WIDGETS[id];
	const reorderable = onUp !== undefined || onDown !== undefined;
	return (
		<li className="flex items-center gap-3 py-2.5">
			<span className="min-w-0 flex-1">
				<span className={cn("block text-sm font-medium", !checked && "text-muted-foreground")}>{label}</span>
				<span className="block text-[11px] leading-4 text-muted-foreground">{hint}</span>
			</span>
			{reorderable && (
				<span className="flex items-center">
					<Button variant="ghost" size="xs" icon={<ArrowUp className="h-3.5 w-3.5" />} onClick={onUp} disabled={!onUp} aria-label={`Move ${label} up`} />
					<Button variant="ghost" size="xs" icon={<ArrowDown className="h-3.5 w-3.5" />} onClick={onDown} disabled={!onDown} aria-label={`Move ${label} down`} />
				</span>
			)}
			<Switch checked={checked} onCheckedChange={() => onToggle(id)} aria-label={`Show ${label}`} />
		</li>
	);
}
