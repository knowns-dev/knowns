import type { ReactNode } from "react";
import { LOGO } from "./model-icons";
import { BRAND_MARK_SVGS, TOOL_SVGS } from "./tool-icons.data";

/** Tool name pattern → brand logo key (logos from @iconify-json/logos, CC0). */
const BRANDS: [RegExp, string][] = [
  [/slack/i, "slack-icon"],
  [/notion/i, "notion-icon"],
  [/github/i, "github-icon"],
  [/postgres|\bpg\b/i, "postgresql"],
  [/linear/i, "linear-icon"],
  [/figma/i, "figma"],
  [/sentry/i, "sentry-icon"],
  [/stripe/i, "stripe"],
  [/gmail/i, "google-gmail"],
  [/calendar/i, "google-calendar"],
  [/drive/i, "google-drive"],
  [/jira/i, "jira"],
  [/\bs3\b/i, "aws-s3"],
  [/vercel/i, "vercel-icon"],
  [/datadog/i, "datadog-icon"],
  [/bigquery|google cloud|\bgcp\b/i, "google-cloud"],
  [/zendesk/i, "zendesk-icon"],
  [/hubspot/i, "hubspot"],
  [/airtable/i, "airtable"],
  [/discord/i, "discord-icon"],
  [/python/i, "python"],
  [/redis/i, "redis"],
  [/maps/i, "google-maps"],
  [/\bnpm\b/i, "npm-icon"],
  [/docker/i, "docker-icon"],
  [/grammar/i, "grammarly-icon"],
  [/chrome|browser/i, "chrome"],
  [/mongo/i, "mongodb-icon"],
  [/mysql/i, "mysql-icon"],
  [/\baws\b/i, "aws"],
  [/jupyter/i, "jupyter"],
  [/elastic/i, "elasticsearch"],
];

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Generic glyphs for tools that are not a brand. */
const GENERIC: [RegExp, ReactNode][] = [
  [
    /search|crawl|lookup|find/i,
    <svg viewBox="0 0 24 24" {...stroke}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>,
  ],
  [
    /shell|bash|terminal|cli|exec/i,
    <svg viewBox="0 0 24 24" {...stroke}><rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M7.5 10l3 2.5-3 2.5M12.5 15.5h4" /></svg>,
  ],
  [
    /doc|sheet|wiki|arxiv|paper|file|pdf|read/i,
    <svg viewBox="0 0 24 24" {...stroke}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></svg>,
  ],
  [
    /translate|web|http|fetch|api|url/i,
    <svg viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" /></svg>,
  ],
  [
    /weather|cloud/i,
    <svg viewBox="0 0 24 24" {...stroke}><path d="M7 18h10a4 4 0 0 0 .5-8A5.5 5.5 0 0 0 7 9.5 4.3 4.3 0 0 0 7 18z" /></svg>,
  ],
  [
    /vision|image|camera|ocr/i,
    <svg viewBox="0 0 24 24" {...stroke}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>,
  ],
  [
    /db|database|sql|store/i,
    <svg viewBox="0 0 24 24" {...stroke}><ellipse cx="12" cy="6" rx="7" ry="2.8" /><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" /></svg>,
  ],
];

/** Brand logo (or a generic glyph) for a tool name such as "Slack" or "Web search", or null if nothing fits. */
export function toolIcon(name?: string): ReactNode | null {
  if (!name) return null;
  const brand = BRANDS.find(([re]) => re.test(name));
  // Trusted, generated SVG markup.
  if (brand) return <span className={LOGO} dangerouslySetInnerHTML={{ __html: onDark(TOOL_SVGS[brand[1]]) }} />;
  return GENERIC.find(([re]) => re.test(name))?.[1] ?? null;
}

/** Zendesk's mark is near-black (#03363d): it follows the text colour so it stays visible in dark mode. */
const onDark = (svg: string) => svg.replace('fill="#03363d"', 'fill="currentColor"');

/** Brand logos that are wordmarks, not square marks: unreadable in a 16px box, so show the name instead. */
const WORDMARKS = new Set(["stripe", "hubspot"]);

/** Like toolIcon, but null for wordmark logos, which do not read at icon size (16px). */
export function toolMark(name?: string): ReactNode | null {
  if (!name) return null;
  const brand = BRANDS.find(([re]) => re.test(name));
  if (brand && WORDMARKS.has(brand[1])) return null;
  return toolIcon(name);
}

/** Product name pattern → single-colour mark key (simple-icons, CC0). */
const MARKS: [RegExp, string][] = [
  [/claude|anthropic/i, "claude"],
  [/openai|\bgpt/i, "openai"],
  [/vercel/i, "vercel"],
  [/next\.?js/i, "nextdotjs"],
  [/\breact\b/i, "react"],
  [/\bvite\b/i, "vite"],
  [/tailwind/i, "tailwindcss"],
  [/shadcn/i, "shadcnui"],
];

/**
 * A single-colour brand mark that follows the text colour, for a product named next to it (e.g. a
 * "Works with" row), or null if there is none. Marks identify the product only; see LICENSES.md.
 */
export function brandMark(name?: string): ReactNode | null {
  if (!name) return null;
  const hit = MARKS.find(([re]) => re.test(name));
  // Trusted, generated SVG markup.
  return hit ? <span className={LOGO} dangerouslySetInnerHTML={{ __html: BRAND_MARK_SVGS[hit[1]] }} /> : null;
}
