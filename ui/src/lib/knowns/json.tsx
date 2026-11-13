import type { ReactNode } from "react";

/** One run of JSON text: a key, a string, a number, a literal (true/false/null) or plain punctuation. */
export interface JsonToken {
  kind: "key" | "string" | "number" | "literal" | "plain";
  text: string;
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Split JSON text into coloured runs. Keys keep their colon as a separate plain run. */
export function jsonTokens(text: string): JsonToken[] {
  const out: JsonToken[] = [];
  const re = new RegExp(TOKEN.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: "plain", text: text.slice(last, m.index) });
    if (m[1] && m[2]) out.push({ kind: "key", text: m[1] }, { kind: "plain", text: m[2] });
    else if (m[1]) out.push({ kind: "string", text: m[1] });
    else if (m[3]) out.push({ kind: "literal", text: m[3] });
    else out.push({ kind: "number", text: m[4] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ kind: "plain", text: text.slice(last) });
  return out;
}

/** Token colours, light and dark. */
export const JSON_TOKEN_CLASS: Record<Exclude<JsonToken["kind"], "plain">, string> = {
  key: "text-sky-700 dark:text-sky-300",
  string: "text-emerald-700 dark:text-emerald-300",
  number: "text-amber-700 dark:text-amber-300",
  literal: "text-violet-700 dark:text-violet-300",
};

/**
 * Pretty-printed JSON with keys, strings, numbers and literals coloured. Strings are shown as they are
 * (tool outputs are often prose). Put it inside a `<pre>`; it renders inline runs only.
 */
export function Json({ value, indent = 2 }: { value: unknown; indent?: number }): ReactNode {
  if (typeof value === "string") return <>{value}</>;
  let text: string;
  try {
    text = JSON.stringify(value, null, indent) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <>
      {jsonTokens(text).map((t, i) =>
        t.kind === "plain" ? (
          t.text
        ) : (
          <span key={i} className={JSON_TOKEN_CLASS[t.kind]}>
            {t.text}
          </span>
        ),
      )}
    </>
  );
}
