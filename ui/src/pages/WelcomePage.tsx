import { useState, useEffect, useCallback } from "react";
import { workspaceApi, type WorkspaceProject, type DirEntry } from "@/ui/api/client";
import { FolderOpen, Folder, ChevronRight, Loader2, Plus, RefreshCw, Github } from "lucide-react";
import { Button } from "@/ui/components/ui/button";
import { ThemeToggle } from "@/ui/components/atoms/ThemeToggle";
import { cn } from "@/ui/lib/utils";
import logoImage from "../public/logo.png";
import { API_BASE, apiFetch } from "@/ui/api/client";

interface WelcomePageProps {
  onProjectSelected: () => void;
}

// ─── Folder tree ─────────────────────────────────────────────────────────────

interface TreeNode {
  entry: DirEntry;
  children: TreeNode[] | null;
  loading: boolean;
  expanded: boolean;
}

function buildNodes(entries: DirEntry[]): TreeNode[] {
  return entries.map(e => ({ entry: e, children: null, loading: false, expanded: false }));
}

function FolderTree({ onSelect }: { onSelect: (path: string) => Promise<void> }) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    workspaceApi.browse()
      .then(entries => setRoots(buildNodes(entries)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback(async (targetPath: string) => {
    const update = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
      return Promise.all(nodes.map(async n => {
        if (n.entry.path === targetPath) {
          if (n.expanded) return { ...n, expanded: false };
          if (n.children !== null) return { ...n, expanded: true };
          return { ...n, loading: true, expanded: true };
        }
        if (n.children) return { ...n, children: await update(n.children) };
        return n;
      }));
    };

    const withLoading = await update(roots);
    setRoots(withLoading);

    const loadChildren = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
      return Promise.all(nodes.map(async n => {
        if (n.entry.path === targetPath && n.loading) {
          try {
            const entries = await workspaceApi.browse(n.entry.path);
            return { ...n, loading: false, children: buildNodes(entries) };
          } catch {
            return { ...n, loading: false, children: [] };
          }
        }
        if (n.children) return { ...n, children: await loadChildren(n.children) };
        return n;
      }));
    };

    setRoots(await loadChildren(withLoading));
  }, [roots]);

  const handleSelect = async (path: string) => {
    setSwitching(path);
    try { await onSelect(path); } finally { setSwitching(null); }
  };

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map(n => (
      <div key={n.entry.path}>
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors group cursor-pointer",
            n.entry.isProject ? "hover:bg-primary/5" : "hover:bg-muted/50"
          )}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          <button
            type="button"
            className={cn(
              "h-4 w-4 shrink-0 flex items-center justify-center rounded",
              (n.entry.hasChildren || n.entry.isProject) ? "hover:bg-muted cursor-pointer" : "opacity-0 pointer-events-none"
            )}
            onClick={() => toggle(n.entry.path)}
          >
            {n.loading
              ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              : <ChevronRight className={cn("h-3 w-3 text-muted-foreground transition-transform", n.expanded && "rotate-90")} />
            }
          </button>
          {n.entry.isProject
            ? <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
            : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          }
          <span
            className="flex-1 truncate"
            onClick={() => !n.entry.isProject && n.entry.hasChildren && toggle(n.entry.path)}
          >
            {n.entry.name}
          </span>
          {n.entry.isProject && (
            <Button
              size="sm"
              variant="default"
              className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 shrink-0"
              disabled={switching === n.entry.path}
              onClick={() => handleSelect(n.entry.path)}
            >
              {switching === n.entry.path ? <Loader2 className="h-3 w-3 animate-spin" /> : "Open"}
            </Button>
          )}
        </div>
        {n.expanded && n.children && n.children.length > 0 && (
          <div>{renderNodes(n.children, depth + 1)}</div>
        )}
        {n.expanded && n.children?.length === 0 && (
          <div className="text-xs text-muted-foreground py-1" style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}>
            Empty
          </div>
        )}
      </div>
    ));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return <div className="py-1">{renderNodes(roots, 0)}</div>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function WelcomePage({ onProjectSelected }: WelcomePageProps) {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [scanning, setScanning] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [tab, setTab] = useState<"saved" | "browse">("saved");
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("theme");
      if (saved) return saved === "dark";
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return false;
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [isDark]);

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await workspaceApi.list() || []);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setScanning(true);
      try {
        await workspaceApi.autoScan();
        await loadProjects();
      } finally {
        setScanning(false);
      }
    })();
  }, [loadProjects]);

  const handleSwitchById = async (id: string) => {
    setSwitching(id);
    try {
      await workspaceApi.switchProject(id);
      onProjectSelected();
    } finally {
      setSwitching(null);
    }
  };

  const handleSwitchByPath = async (path: string) => {
    await workspaceApi.switchByPath(path);
    onProjectSelected();
  };

  const handleInit = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/init`, { method: "POST" });
      if (!res.ok) throw new Error();
      await loadProjects();
    } catch {
      window.alert("Run 'knowns init' in your terminal to initialize this folder.");
    }
  };

  const version = import.meta.env.APP_VERSION;

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">

      {/* Top-right controls */}
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <a
          href="https://github.com/knowns-dev/knowns"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Github className="h-4 w-4" />
          GitHub
        </a>
        {version && (
          <a
            href="https://knowns.sh/changelog"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            {version}
          </a>
        )}
        <ThemeToggle isDark={isDark} onToggle={() => setIsDark(d => !d)} size="sm" />
      </div>

      <div className="w-full max-w-lg space-y-8">

        {/* Header */}
        <div className="text-center space-y-3">
          <img src={logoImage} alt="Knowns" className="mx-auto h-16 w-16 rounded-2xl object-contain" />
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">Knowns</h1>
            <p className="text-sm text-muted-foreground">Your project memory, always within reach.</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {(["saved", "browse"] as const).map(t => (
            <button
              key={t}
              type="button"
              className={cn(
                "px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
                tab === t
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTab(t)}
            >
              {t === "saved" ? "Projects" : "Browse"}
            </button>
          ))}
        </div>

        {/* Saved tab */}
        {tab === "saved" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {scanning ? "Scanning…" : `${projects.length} project${projects.length !== 1 ? "s" : ""} found`}
              </span>
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={async () => { setScanning(true); await workspaceApi.autoScan(); await loadProjects(); setScanning(false); }}
                disabled={scanning}
              >
                <RefreshCw className={cn("h-3 w-3", scanning && "animate-spin")} />
                Rescan
              </button>
            </div>

            <div className="rounded-xl border overflow-hidden">
              {scanning ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Scanning for projects…
                </div>
              ) : projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
                  <FolderOpen className="h-8 w-8 opacity-30" />
                  <span className="text-sm">No projects found</span>
                  <Button variant="outline" size="sm" onClick={() => setTab("browse")}>
                    Browse filesystem
                  </Button>
                </div>
              ) : (
                <ul className="divide-y">
                  {projects.map(p => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors disabled:opacity-50"
                        onClick={() => handleSwitchById(p.id)}
                        disabled={switching === p.id}
                      >
                        {switching === p.id
                          ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                          : <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                        }
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-sm truncate">{p.name}</div>
                          <div className="text-xs text-muted-foreground truncate" title={p.path}>{p.path}</div>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Button variant="outline" size="sm" className="w-full" onClick={handleInit}>
              <Plus className="h-4 w-4 mr-2" />
              Initialize current folder as project
            </Button>
          </div>
        )}

        {/* Browse tab */}
        {tab === "browse" && (
          <div className="rounded-xl border overflow-hidden max-h-96 overflow-y-auto">
            <FolderTree onSelect={handleSwitchByPath} />
          </div>
        )}
      </div>
    </div>
  );
}
