import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { modelIcon } from "@/ui/lib/knowns/icons/model-icons";
import { toolIcon } from "@/ui/lib/knowns/icons/tool-icons";
import type { WorkedBy } from "@/ui/models/task";

/** Display name and logo for the MCP client slugs the server records in Task.workedBy (KN-4FQN0P). */
const AGENTS: Record<string, { name: string; icon: () => ReactNode | null }> = {
	"claude-code": { name: "Claude Code", icon: () => modelIcon("claude") },
	claude: { name: "Claude", icon: () => modelIcon("claude") },
	codex: { name: "Codex", icon: () => modelIcon("openai") },
	"gemini-cli": { name: "Gemini CLI", icon: () => modelIcon("gemini") },
	cursor: { name: "Cursor", icon: () => toolIcon("Cursor") },
	opencode: { name: "OpenCode", icon: () => null },
	windsurf: { name: "Windsurf", icon: () => null },
	cline: { name: "Cline", icon: () => null },
	"roo-code": { name: "Roo Code", icon: () => null },
	copilot: { name: "GitHub Copilot", icon: () => toolIcon("GitHub") },
	zed: { name: "Zed", icon: () => null },
	kiro: { name: "Kiro", icon: () => null },
	amp: { name: "Amp", icon: () => null },
	pi: { name: "Pi", icon: () => null },
};

const titleCase = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function agentName(client: string): string {
	return AGENTS[client]?.name ?? titleCase(client);
}

/** The agent's logo, or a generic bot glyph for a client without one. */
export function agentIcon(client: string): ReactNode {
	return AGENTS[client]?.icon() ?? <Bot aria-hidden />;
}

/** "Claude Code", or "Claude Code 2.1" when the client sent a version. */
export function agentLabel(w: Pick<WorkedBy, "client" | "version">): string {
	return agentName(w.client);
}

/** Whole minutes since the claim, as "3m" / "2h 5m". */
export function agentSince(since: string, now = Date.now()): string {
	const mins = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60000));
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m`;
	const h = Math.floor(mins / 60);
	return mins % 60 === 0 ? `${h}h` : `${h}h ${mins % 60}m`;
}
