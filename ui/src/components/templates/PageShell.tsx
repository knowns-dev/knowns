import type { ReactNode } from "react";
import { Button } from "@/ui/components/ui/button";
import { Skeleton } from "@/ui/components/ui/skeleton";
import { cn } from "@/ui/lib/utils";

interface PageShellProps {
	children: ReactNode;
	className?: string;
}

interface PageHeaderProps {
	title: ReactNode;
	description?: ReactNode;
	context?: ReactNode;
	status?: ReactNode;
	actions?: ReactNode;
	className?: string;
}

interface PageContentProps {
	children: ReactNode;
	className?: string;
	size?: "default" | "wide" | "full";
}

interface PageLoadingProps {
	label?: string;
	className?: string;
}

interface PageErrorProps {
	title?: ReactNode;
	description: ReactNode;
	onRetry?: () => void;
	className?: string;
}

const contentWidths: Record<NonNullable<PageContentProps["size"]>, string> = {
	default: "max-w-[1440px]",
	wide: "max-w-[1680px]",
	full: "max-w-none",
};

export function PageShell({ children, className }: PageShellProps) {
	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function PageHeader({
	title,
	description,
	context,
	status,
	actions,
	className,
}: PageHeaderProps) {
	return (
		<header className={cn("shrink-0 border-b border-border/70 bg-card", className)}>
			<div className="mx-auto flex w-full max-w-[1440px] flex-col justify-between gap-4 px-4 py-5 sm:flex-row sm:items-end sm:px-6">
				<div className="min-w-0">
					{(context || status) && (
						<div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
							{context && <span>{context}</span>}
							{context && status && <span aria-hidden="true">/</span>}
							{status && (
								<span
									role="status"
									aria-live="polite"
									className="normal-case tracking-normal"
								>
									{status}
								</span>
							)}
						</div>
					)}
					<h1 className="text-2xl font-semibold tracking-[-0.035em]">{title}</h1>
					{description && (
						<div className="mt-1 text-sm text-muted-foreground">{description}</div>
					)}
				</div>
				{actions && (
					<div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
				)}
			</div>
		</header>
	);
}

export function PageContent({
	children,
	className,
	size = "default",
}: PageContentProps) {
	return (
		<div
			className={cn(
				"mx-auto min-h-0 w-full flex-1 overflow-auto px-4 py-5 sm:px-6",
				contentWidths[size],
				className,
			)}
		>
			{children}
		</div>
	);
}

export function PageLoading({
	label = "Loading page content",
	className,
}: PageLoadingProps) {
	return (
		<div
			role="status"
			aria-live="polite"
			aria-busy="true"
			className={cn("min-h-64 space-y-5", className)}
		>
			<span className="sr-only">{label}</span>
			<div aria-hidden="true" className="space-y-5">
				<div className="flex items-center justify-between gap-4">
					<div className="space-y-2">
						<Skeleton className="h-4 w-28" />
						<Skeleton className="h-3 w-44 max-w-full" />
					</div>
					<Skeleton className="h-8 w-24" />
				</div>
				<div className="grid gap-4 md:grid-cols-3">
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-24 w-full" />
				</div>
				<Skeleton className="h-48 w-full" />
			</div>
		</div>
	);
}

export function PageError({
	title = "Unable to load this page",
	description,
	onRetry,
	className,
}: PageErrorProps) {
	return (
		<section
			role="alert"
			className={cn(
				"flex min-h-64 flex-col items-start justify-center rounded-lg border border-border/70 bg-card p-6",
				className,
			)}
		>
			<h2 className="text-base font-semibold">{title}</h2>
			<div className="mt-1 max-w-xl text-sm text-muted-foreground">{description}</div>
			{onRetry && (
				<Button className="mt-4 h-11 sm:h-8" variant="outline" size="sm" onClick={onRetry}>
					Try again
				</Button>
			)}
		</section>
	);
}
