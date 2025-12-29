import { Icon, Input } from "../atoms";
import { cn } from "@/ui/lib/utils";

interface SearchInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}

export function SearchInput({ value, onChange, placeholder = "Search...", className }: SearchInputProps) {
	return (
		<div className={cn("relative", className)}>
			<Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="pl-10"
			/>
		</div>
	);
}
