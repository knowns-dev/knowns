// Go-style transport error text. The degraded notice quotes the underlying error, and Go's
// net/http renders `Post "<url>": dial tcp 127.0.0.1:9: connect: connection refused`. fetch
// reports a bare code, so the common failures are rendered the way Go would.

function hostPort(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port !== "" ? u.port : u.protocol === "https:" ? "443" : "80";
    const host = u.hostname === "localhost" ? "[::1]" : u.hostname;
    return `${host}:${port}`;
  } catch {
    return url;
  }
}

/** The *url.Error text for a failed request: `<Method> "<url>": <cause>`. */
export function goTransportError(method: string, url: string, err: unknown): string {
  const op = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const e = err as { code?: string; name?: string; message?: string };
  let detail = e?.message ?? String(err);
  if (e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED") {
    detail = `dial tcp ${hostPort(url)}: connect: connection refused`;
  } else if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    detail = "context deadline exceeded (Client.Timeout exceeded while awaiting headers)";
  }
  return `${op} "${url}": ${detail}`;
}
