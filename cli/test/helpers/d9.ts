// D9 (spec mcp-thin-proxy): `knowns browser` gained --foreground and --stop. The 0.34.1 oracle
// has neither, so parity tests drop their completion candidates before comparing.
export function withoutD9(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => !/^--(foreground|keep-alive|stop)(\t|$)/.test(l))
    .join("\n");
}
