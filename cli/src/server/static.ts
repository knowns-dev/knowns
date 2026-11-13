// internal/server/server.go mountUI: the embedded ui/dist served at /, with http.FileServer's
// behaviour (301 for a directory without a slash and for /index.html, Range support) and the SPA
// fallback to index.html for every other path.
import { getUiAsset, listUiAssets } from "../ui.ts";
import { httpError } from "./http.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".xml": "text/xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/vnd.microsoft.icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

let dirs: Set<string> | undefined;
function directories(): Set<string> {
  if (!dirs) {
    dirs = new Set();
    for (const f of listUiAssets()) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return dirs;
}

/** fs.ValidPath: no leading or trailing slash, no empty, "." or ".." elements. */
function validPath(p: string): boolean {
  if (p === ".") return true;
  return p.split("/").every((e) => e !== "" && e !== "." && e !== "..");
}

function contentType(path: string, bytes: Uint8Array): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  const known = MIME[ext];
  if (known) return known;
  const head = bytes.subarray(0, 512);
  const text = head.every(
    (b) => b === 9 || b === 10 || b === 12 || b === 13 || (b >= 0x20 && b < 0x7f) || b >= 0x80,
  );
  return text ? "text/plain; charset=utf-8" : "application/octet-stream";
}

function serveFile(req: Request, path: string, bytes: Uint8Array): Response {
  const type = contentType(path, bytes);
  const headers: Record<string, string> = { "Accept-Ranges": "bytes", "Content-Type": type };
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const size = bytes.length;
      let start: number;
      let end: number;
      if (m[1] === "") {
        const n = Number(m[2]);
        start = Math.max(0, size - n);
        end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
      if (start >= size || start > end) {
        return new Response("invalid range: failed to overlap\n", {
          status: 416,
          headers: {
            "Content-Range": `bytes */${size}`,
            "Content-Type": "text/plain; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` },
      });
    }
  }
  return new Response(bytes, { status: 200, headers });
}

export async function serveUi(req: Request, urlPath: string): Promise<Response> {
  if (urlPath.startsWith("/api/")) return httpError(404, "404 page not found");
  const fsPath = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\//, "");
  const isFile = validPath(fsPath) && getUiAsset(fsPath) !== null;
  const isDir = validPath(fsPath) && directories().has(fsPath);
  if (isFile || isDir) {
    // http.FileServer
    if (urlPath === "/") return serveFile(req, "index.html", await bytesOf("index.html"));
    if (urlPath.endsWith("/index.html")) {
      return new Response(null, { status: 301, headers: { Location: "./" } });
    }
    if (isDir) {
      const base = fsPath.slice(fsPath.lastIndexOf("/") + 1);
      return new Response(null, { status: 301, headers: { Location: `${base}/` } });
    }
    return serveFile(req, fsPath, await bytesOf(fsPath));
  }
  const index = getUiAsset("index.html");
  if (!index) return httpError(404, "404 page not found");
  return new Response(await index.arrayBuffer(), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function bytesOf(path: string): Promise<Uint8Array> {
  const blob = getUiAsset(path);
  return new Uint8Array(await (blob as Blob).arrayBuffer());
}
