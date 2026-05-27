import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
);
const isProd = process.env.NODE_ENV === "production";
const appVersion = process.env.APP_VERSION || pkg.version;

const API_URL = isProd ? "" : process.env.API_URL || "http://localhost:6420";
const WS_URL = isProd ? "" : process.env.WS_URL || "ws://localhost:6420";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src",
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@/ui": path.resolve(__dirname, "src"),
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },
  optimizeDeps: {
    include: ["react-force-graph-2d"],
  },
  server: {
    port: 6421,
    allowedHosts: "all",
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Mermaid + its deps — kept together for embedded file server compatibility
          if (
            id.includes("node_modules/mermaid") ||
            id.includes("node_modules/dagre") ||
            id.includes("node_modules/@mermaid-js") ||
            id.includes("node_modules/d3") ||
            id.includes("node_modules/elkjs") ||
            id.includes("node_modules/cytoscape") ||
            id.includes("node_modules/react-force-graph-2d") ||
            id.includes("node_modules/force-graph")
          ) {
            return "mermaid-vendor";
          }

          // highlight.js — large standalone chunk (all languages bundled)
          if (id.includes("node_modules/highlight.js/")) {
            return "highlight-vendor";
          }

          // React core
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "react-vendor";
          }

          // Routing + table
          if (id.includes("node_modules/@tanstack/")) {
            return "tanstack-vendor";
          }

          // Radix UI primitives
          if (id.includes("node_modules/@radix-ui/")) {
            return "radix-vendor";
          }

          // Animation + DnD
          if (
            id.includes("node_modules/framer-motion/") ||
            id.includes("node_modules/@dnd-kit/")
          ) {
            return "motion-vendor";
          }

          // Markdown / editor processing
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/remark") ||
            id.includes("node_modules/rehype") ||
            id.includes("node_modules/unified/") ||
            id.includes("node_modules/micromark") ||
            id.includes("node_modules/mdast") ||
            id.includes("node_modules/hast") ||
            id.includes("node_modules/vfile") ||
            id.includes("node_modules/unist") ||
            id.includes("node_modules/marked/") ||
            id.includes("node_modules/react-markdown-editor-lite/") ||
            id.includes("node_modules/turndown/") ||
            id.includes("node_modules/diff/")
          ) {
            return "editor-vendor";
          }

          // Misc UI utilities
          if (
            id.includes("node_modules/lucide-react/") ||
            id.includes("node_modules/cmdk/") ||
            id.includes("node_modules/sonner/") ||
            id.includes("node_modules/tunnel-rat/") ||
            id.includes("node_modules/class-variance-authority/") ||
            id.includes("node_modules/clsx/") ||
            id.includes("node_modules/tailwind-merge/")
          ) {
            return "ui-vendor";
          }
        },
      },
    },
  },
  define: {
    "import.meta.env.API_URL": JSON.stringify(API_URL),
    "import.meta.env.WS_URL": JSON.stringify(WS_URL),
    "import.meta.env.APP_VERSION": JSON.stringify(appVersion),
  },
});
