/**
 * Atoms - Basic UI building blocks
 * Re-exports from shadcn/ui and custom atoms
 */

// Re-export shadcn/ui components as atoms
export { Button, buttonVariants, type ButtonProps } from "../ui/button";
export { Input } from "../ui/input";
export { Textarea } from "../ui/textarea";
export { Skeleton } from "../ui/skeleton";
export { Separator } from "../ui/separator";

// Custom atoms
export { default as Avatar } from "./Avatar";
export { Badge, badgeVariants, type BadgeProps } from "./Badge";
export { ConnectionStatus } from "./ConnectionStatus";
export { Spinner } from "./Spinner";
export { Icon, type IconName } from "./Icon";
export { ThemeToggle } from "./ThemeToggle";
