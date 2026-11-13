// strconv.Quote, for messages that Go builds with %q / strconv.Quote.
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\x07":
        out += "\\a";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\v":
        out += "\\v";
        continue;
    }
    if (ch === " " || PRINTABLE.test(ch)) {
      out += ch;
    } else if (cp < 0x20 || cp === 0x7f) {
      out += `\\x${cp.toString(16).padStart(2, "0")}`;
    } else if (cp < 0x10000) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else {
      out += `\\U${cp.toString(16).padStart(8, "0")}`;
    }
  }
  return `${out}"`;
}
