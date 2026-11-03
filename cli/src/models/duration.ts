// Go time.ParseDuration, ported so config validation accepts and rejects exactly the same strings.

const UNIT_NS: Record<string, bigint> = {
  ns: 1n,
  us: 1000n,
  µs: 1000n, // micro sign
  μs: 1000n, // greek mu
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

const MAX_INT64 = (1n << 63n) - 1n;

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";

/** time.ParseDuration: returns nanoseconds. Throws on any string Go rejects. */
export function parseGoDuration(input: string): bigint {
  const orig = input;
  let s = input;
  let neg = false;
  if (s !== "") {
    const c = s[0];
    if (c === "-" || c === "+") {
      neg = c === "-";
      s = s.slice(1);
    }
  }
  if (s === "0") return 0n;
  if (s === "") throw new Error(`time: invalid duration "${orig}"`);

  // Work in a scaled integer domain so fractions stay exact: value * 10^frac digits.
  let total = 0n;
  while (s !== "") {
    // integer part
    let i = 0;
    while (i < s.length && isDigit(s[i])) i++;
    const intPart = s.slice(0, i);
    s = s.slice(i);
    let fracPart = "";
    let hasDot = false;
    if (s[0] === ".") {
      hasDot = true;
      s = s.slice(1);
      let j = 0;
      while (j < s.length && isDigit(s[j])) j++;
      fracPart = s.slice(0, j);
      s = s.slice(j);
    }
    if (intPart === "" && fracPart === "") {
      // Go: "." alone or no digits at all is invalid.
      throw new Error(`time: invalid duration "${orig}"`);
    }
    void hasDot;

    // unit
    let k = 0;
    while (k < s.length && s[k] !== "." && !isDigit(s[k])) k++;
    if (k === 0) throw new Error(`time: missing unit in duration "${orig}"`);
    const unit = s.slice(0, k);
    s = s.slice(k);
    const scale = UNIT_NS[unit];
    if (scale === undefined) throw new Error(`time: unknown unit "${unit}" in duration "${orig}"`);

    const ip = intPart === "" ? 0n : BigInt(intPart);
    let part = ip * scale;
    if (fracPart !== "") {
      part += (BigInt(fracPart) * scale) / 10n ** BigInt(fracPart.length);
    }
    if (part > MAX_INT64) throw new Error(`time: invalid duration "${orig}"`);
    total += part;
    if (total > MAX_INT64) throw new Error(`time: invalid duration "${orig}"`);
  }
  return neg ? -total : total;
}

/**
 * ParseTaskLifecycleDuration: Go duration strings plus an integer day suffix ("30d"). Negative and
 * empty values are rejected. Returns nanoseconds.
 */
export function parseTaskLifecycleDuration(raw: string): bigint {
  const value = raw.trim();
  if (value === "") throw new Error("duration is required");

  let duration: bigint;
  try {
    if (value.endsWith("d")) {
      const daysText = value.slice(0, -1);
      if (!/^[+-]?\d+$/.test(daysText)) {
        throw new Error(`strconv.ParseInt: parsing "${daysText}": invalid syntax`);
      }
      const days = BigInt(daysText);
      const day = 24n * 3_600_000_000_000n;
      if (days < 0n) throw new Error("duration must not be negative");
      if (days > MAX_INT64 / day) throw new Error("duration overflows");
      duration = days * day;
    } else {
      duration = parseGoDuration(value);
    }
  } catch (e) {
    throw new Error(`invalid duration "${value}": ${(e as Error).message}`);
  }
  if (duration < 0n) throw new Error("duration must not be negative");
  return duration;
}
