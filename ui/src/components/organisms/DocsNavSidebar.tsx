import { createContext, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { BookOpenText, Folder, FolderGit2, GitBranch, Package, Package2, Plus, Search, X } from "lucide-react";
import {
	DocsSidebar,
	filterSections,
	type DocsCategory,
	type DocsFilter,
	type DocsPage,
	type DocsSection,
} from "@/ui/components/ui/knowns/blocks/sidebar/sidebar-docs";
import { Input } from "@/ui/components/ui/knowns/input";
import { Button } from "../ui/button";
import { importApi, type Import } from "../../api/client";
import { navigateTo } from "../../lib/navigation";
import { isSpec, toDisplayPath, type Doc } from "../../lib/utils";

export type DocsNavFilter = "all" | "specs" | "imported";

/** `/docs/guides/getting-started.md`, each segment encoded. */
export function docHref(doc: Doc): string {
	return `/docs/${normalized(doc.path).split("/").map(encodeURIComponent).join("/")}`;
}

function folderHref(folder: string): string {
	return `/docs/${folder.split("/").map(encodeURIComponent).join("/")}`;
}

function normalized(path: string): string {
	return toDisplayPath(path).replace(/^\/+/, "");
}

function folderOf(doc: Doc): string {
	if (doc.folder) return normalized(doc.folder).replace(/\/+$/, "");
	const parts = normalized(doc.path).split("/");
	return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

/** The import an imported doc came from: its source, else the first path segment. */
function importSource(doc: Doc): string {
	if (doc.source) return doc.source;
	return normalized(doc.path).split("/")[0] || "imported";
}

function byOrderThenTitle(a: Doc, b: Doc): number {
	const oa = a.metadata.order;
	const ob = b.metadata.order;
	if (oa !== undefined && ob !== undefined && oa !== ob) return oa - ob;
	if (oa !== undefined && ob === undefined) return -1;
	if (ob !== undefined && oa === undefined) return 1;
	return a.metadata.title.localeCompare(b.metadata.title);
}

const pageFor = (doc: Doc): DocsPage => ({ id: normalized(doc.path), label: doc.metadata.title || normalized(doc.path), href: docHref(doc) });

/**
 * One section per top-level folder (pages straight inside it, then a category per deeper folder),
 * root docs under "Docs", and a section per import source after the local ones.
 */
export function buildDocsSections(docs: Doc[], imports: Map<string, Import> = new Map()): DocsSection[] {
	const group = (list: Doc[], base: string, id: string, label: string, icon: ReactNode, href?: string): DocsSection => {
		const direct: Doc[] = [];
		const nested = new Map<string, Doc[]>();
		for (const doc of list) {
			const folder = folderOf(doc);
			const rest = base && folder.startsWith(base) ? folder.slice(base.length).replace(/^\/+/, "") : folder;
			if (!rest) direct.push(doc);
			else nested.set(rest, [...(nested.get(rest) || []), doc]);
		}
		const categories: DocsCategory[] = [...nested.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([rest, docsIn]) => ({
				id: `${id}/${rest}`,
				label: rest,
				href: base ? folderHref(`${base}/${rest}`) : undefined,
				pages: docsIn.sort(byOrderThenTitle).map(pageFor),
			}));
		return { id, label, icon, href, pages: direct.sort(byOrderThenTitle).map(pageFor), categories, count: true };
	};

	const local = docs.filter((doc) => !doc.isImported);
	const byTop = new Map<string, Doc[]>();
	const root: Doc[] = [];
	for (const doc of local) {
		const top = folderOf(doc).split("/")[0];
		if (!top) root.push(doc);
		else byTop.set(top, [...(byTop.get(top) || []), doc]);
	}

	const sections: DocsSection[] = [];
	if (root.length > 0) sections.push(group(root, "", "root", "Docs", <BookOpenText />, "/docs"));
	for (const [top, docsIn] of [...byTop.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		sections.push(group(docsIn, top, `folder:${top}`, top, <Folder />, folderHref(top)));
	}

	const bySource = new Map<string, Doc[]>();
	for (const doc of docs.filter((d) => d.isImported)) {
		const source = importSource(doc);
		bySource.set(source, [...(bySource.get(source) || []), doc]);
	}
	for (const [source, docsIn] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const type = imports.get(source)?.type;
		const icon = type === "git" ? <GitBranch /> : type === "npm" ? <Package2 /> : type === "local" ? <FolderGit2 /> : <Package />;
		sections.push(group(docsIn, source, `import:${source}`, source, icon));
	}
	return sections;
}

function matchesQuery(doc: Doc, query: string): boolean {
	if (!query) return true;
	return [doc.metadata.title, normalized(doc.path), doc.metadata.description || "", ...(doc.metadata.tags || [])]
		.join(" ")
		.toLowerCase()
		.includes(query);
}

/** Lets the sidebar's links route in the app and close the mobile sheet. */
const NavContext = createContext<() => void>(() => {});

function DocNavLink({ href, className, children, "aria-current": ariaCurrent }: { href: string; className?: string; children?: ReactNode; "aria-current"?: "page" }) {
	const onNavigate = useContext(NavContext);
	const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
		event.preventDefault();
		void navigateTo(href);
		onNavigate();
	};
	return (
		<a href={href} className={className} aria-current={ariaCurrent} onClick={handleClick}>
			{children}
		</a>
	);
}

interface DocsNavSidebarProps {
	docs: Doc[];
	selectedDocPath?: string | null;
	filter: DocsNavFilter;
	onFilterChange: (filter: DocsNavFilter) => void;
	searchQuery: string;
	onSearchQueryChange: (value: string) => void;
	onCreateDoc: () => void;
	/** Called after a link is followed, e.g. to close the mobile sheet. */
	onItemSelect?: () => void;
	/** Before the search field, e.g. the button that hides this sidebar. */
	searchLeading?: ReactNode;
	className?: string;
}

/**
 * The doc view's library, on the Knowns UI docs sidebar: folders as sections with counts, nested
 * folders as categories, import sources after them, a search field, and All / Specs / Imported.
 */
export function DocsNavSidebar({
	docs,
	selectedDocPath,
	filter,
	onFilterChange,
	searchQuery,
	onSearchQueryChange,
	onCreateDoc,
	onItemSelect,
	searchLeading,
	className,
}: DocsNavSidebarProps) {
	const [imports, setImports] = useState<Map<string, Import>>(new Map());
	useEffect(() => {
		importApi
			.list()
			.then(({ imports: list }) => setImports(new Map(list.map((item) => [item.name, item]))))
			.catch((err) => console.error("Failed to fetch imports:", err));
	}, []);

	const query = searchQuery.trim().toLowerCase();
	const docById = useMemo(() => new Map(docs.map((doc) => [normalized(doc.path), doc])), [docs]);
	const sections = useMemo(() => {
		const all = buildDocsSections(docs, imports);
		return query ? filterSections(all, (page) => {
			const doc = docById.get(page.id);
			return doc ? matchesQuery(doc, query) : false;
		}) : all;
	}, [docs, imports, query, docById]);

	const filters: DocsFilter[] = useMemo(
		() => [
			{ id: "all", label: "All", match: () => true, expand: Boolean(query) },
			{ id: "specs", label: "Specs", match: (page: DocsPage) => Boolean(docById.get(page.id) && isSpec(docById.get(page.id)!)), expand: Boolean(query) },
			{ id: "imported", label: "Imported", match: (page: DocsPage) => Boolean(docById.get(page.id)?.isImported), expand: Boolean(query) },
		],
		[docById, query],
	);

	const current = selectedDocPath ? normalized(selectedDocPath) : "";

	return (
		<NavContext.Provider value={onItemSelect ?? (() => {})}>
			<DocsSidebar
				sections={sections}
				current={current}
				filters={filters}
				filter={filter}
				onFilterChange={(id) => onFilterChange(id as DocsNavFilter)}
				searchLeading={
					<>
						{searchLeading}
						<Input
							value={searchQuery}
							onChange={(event) => onSearchQueryChange(event.target.value)}
							placeholder="Search docs, paths, tags..."
							aria-label="Search docs"
							icon={<Search />}
							trailing={
								searchQuery ? (
									<button
										type="button"
										onClick={() => onSearchQueryChange("")}
										className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
										aria-label="Clear search"
									>
										<X className="size-3.5" />
									</button>
								) : undefined
							}
							className="min-w-0 flex-1"
						/>
					</>
				}
				renderMark={(page) => {
					const doc = docById.get(page.id);
					return doc && isSpec(doc) ? (
						<span className="ml-auto shrink-0 rounded-md bg-sky-500/10 px-1.5 text-[10.5px] font-medium leading-[18px] text-sky-700 dark:text-sky-300">Spec</span>
					) : null;
				}}
				storageKey="knowns.docs.nav"
				linkAs={DocNavLink}
				label="Docs"
				emptyText={query ? "No docs match this search." : filter === "specs" ? "No specs yet." : filter === "imported" ? "No imported docs." : "No docs yet."}
				footer={
					<Button variant="outline" size="sm" onClick={onCreateDoc} className="w-full">
						<Plus className="size-3.5" />
						New Doc
					</Button>
				}
				className={className}
			/>
		</NavContext.Provider>
	);
}
