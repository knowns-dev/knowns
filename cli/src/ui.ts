import { uiAssets } from "./ui-assets.generated.ts";

/** Returns the embedded ui/dist file for a URL-style path ("/" maps to index.html), or null. */
export function getUiAsset(path: string): Blob | null {
  let p = path.replace(/^\/+/, "");
  if (p === "") p = "index.html";
  const file = uiAssets[p];
  return file ?? null;
}

export function listUiAssets(): string[] {
  return Object.keys(uiAssets);
}
