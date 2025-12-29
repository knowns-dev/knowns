import type { ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

interface FormFieldProps {
	label: string;
	error?: string;
	required?: boolean;
	className?: string;
	children: ReactNode;
}

export function FormField({ label, error, required, className, children }: FormFieldProps) {
	return (
		<div className={cn("space-y-1.5", className)}>
			<label className="text-sm font-medium text-foreground">
				{label}
				{required && <span className="text-destructive ml-1">*</span>}
			</label>
			{children}
			{error && <p className="text-sm text-destructive">{error}</p>}
		</div>
	);
}
