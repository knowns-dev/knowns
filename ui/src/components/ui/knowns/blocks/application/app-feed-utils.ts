const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
}

/** "2026-11-07": the calendar day of a timestamp (ms) in a time zone. */
export function dayKey(ts: number, timeZone = "UTC"): string {
  return parts(timeZone).format(new Date(ts));
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayNumber = (key: string) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / 86_400_000;

/** "Today", "Yesterday", else "Tuesday, 3 Nov" (and the year when it is not the current one). */
export function dayLabel(key: string, nowKey: string): string {
  const diff = dayNumber(nowKey) - dayNumber(key);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const d = new Date(dayNumber(key) * 86_400_000);
  const base = `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return key.slice(0, 4) === nowKey.slice(0, 4) ? base : `${base} ${key.slice(0, 4)}`;
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Newest first, grouped by calendar day. Items keep their order inside a day. */
export function groupByDay<T extends { at: number }>(items: readonly T[], now: number, timeZone = "UTC"): DayGroup<T>[] {
  const nowKey = dayKey(now, timeZone);
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const groups: DayGroup<T>[] = [];
  for (const item of sorted) {
    const key = dayKey(item.at, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(key, nowKey), items: [item] });
  }
  return groups;
}

/** "now", "5m", "3h", "2d", "3w", "4mo", "2y": one unit, no "ago". */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round(d / 365)}y`;
}

/** Full time for a title/tooltip, in the given zone: "7 Nov 2026, 14:05". */
export function fullTime(ts: number, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts)).replace(" at ", ", ");
}
