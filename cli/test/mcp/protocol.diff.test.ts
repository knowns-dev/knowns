// Wire-level parity: initialize, tools/list (every schema), error codes and texts for malformed and
// unsupported requests, sent as raw lines to Go and TS. Responses are compared by id (tool calls
// answer from a worker pool in Go, so arrival order is not part of the contract).
import { describe, expect, test } from "bun:test";
import { hasGoBin, McpSession, makeSandbox, maskPath } from "./harness.ts";

const LINES: string[] = [
  '{"jsonrpc":"2.0","id":1,"method":"resources/templates/list"}',
  '{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"x"}}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope"}}',
  '{"jsonrpc":"2.0","id":4,"method":"tools/call"}',
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":"x"}',
  "not json",
  '{"jsonrpc":"1.0","id":6,"method":"ping"}',
  '{"jsonrpc":"2.0","id":"abc","method":"ping"}',
  '{"jsonrpc":"2.0","id":1.5,"method":"ping"}',
  '{"jsonrpc":"2.0","id":7,"method":"logging/setLevel","params":{"level":"info"}}',
  '{"jsonrpc":"2.0","id":8,"method":"completion/complete","params":{}}',
  '{"jsonrpc":"2.0","id":9,"method":"tasks/list"}',
  '{"jsonrpc":"2.0","id":null,"method":"ping"}',
  '{"jsonrpc":"2.0","id":10,"method":"tools/list","params":{"cursor":"!!"}}',
  '{"jsonrpc":"2.0","id":11,"method":"initialize","params":{"protocolVersion":"bogus"}}',
  '{"jsonrpc":"2.0","id":12,"method":"initialize"}',
  "[1,2]",
  '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"help","arguments":{"queries":["code.*"]}}}',
  '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"help","arguments":[]}}',
  '{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"help","arguments":{"queries":["nothing"],"zzz":1}}}',
  '{"jsonrpc":"2.0","id":16,"method":"tools/list","params":[]}',
  '{"jsonrpc":"2.0","id":17,"method":"ping","params":5}',
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":5}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"help","arguments":5}}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"help","arguments":"x"}}',
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"help","_meta":5}}',
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":null}',
  '{"jsonrpc":"2.0","id":6,"method":"initialize","params":5}',
  '{"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":5}}',
  '{"jsonrpc":"2.0","id":8,"method":"initialize","params":{"clientInfo":5}}',
  '{"jsonrpc":"2.0","id":9,"method":"initialize","params":{"clientInfo":{"name":5}}}',
  '{"jsonrpc":"2.0","id":10,"method":"initialize","params":{"capabilities":5}}',
  '{"jsonrpc":"2.0","id":11,"method":"tools/list","params":{"cursor":5}}',
  '{"jsonrpc":"2.0","id":12,"method":"resources/list","params":5}',
  '{"jsonrpc":"2.0","id":13,"method":"resources/read","params":5}',
  '{"jsonrpc":"2.0","id":14,"method":"resources/read","params":{"uri":5}}',
  '{"jsonrpc":"2.0","id":15,"method":"resources/read"}',
  '{"jsonrpc":"2.0","id":16,"method":"resources/templates/list","params":5}',
  '{"jsonrpc":"2.0","id":17,"method":"ping","params":{"_meta":5}}',
  '{"jsonrpc":"2.0","method":"x","params":5}',
  '{"jsonrpc":"2.0","id":18,"error":{"code":1,"message":"x"}}',
  '{"jsonrpc":"2.0","id":19,"result":null,"method":"ping"}',
  '{"jsonrpc":"2.0","id":20,"result":1,"method":"ping"}',
  '{"jsonrpc":2,"id":21,"method":"ping"}',
  '{"jsonrpc":"2.0","id":22,"method":5}',
  '{"jsonrpc":"2.0","id":[1],"method":"ping"}',
  '{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}',
  '{"jsonrpc":"2.0","id":true,"method":"ping"}',
  "null",
  "5",
  '"s"',
  "{}",
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"cursor":"YWNj"}}',
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"help","arguments":{"queries":["tasks.*","insert","docs.get","workflow.*","decision","project"]}}}',
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"project","arguments":{"action":"current"}}}',
  '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"validate","arguments":{}}}',
  '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"project","arguments":{"action":"nope"}}}',
  '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"project","arguments":{"action":"set","projectRoot":"/nonexistent"}}}',
  '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"project","arguments":{"action":"set"}}}',
  '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"project","arguments":{"action":"current","zzz":1,"aaa":2}}}',
  '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"project","arguments":{}}}',
];

async function collect(side: "go" | "ts"): Promise<string[]> {
  const sb = makeSandbox("full");
  const s = new McpSession(side, { cwd: sb.dir, home: sb.home });
  for (const l of LINES) s.sendRaw(l);
  await Bun.sleep(1500);
  await s.close();
  return s.lines.map((l) => maskPath(l, sb.dir, "<DIR>")).sort();
}

describe.skipIf(!hasGoBin)("wire protocol matches Go", () => {
  test("raw session", async () => {
    const [go, ts] = await Promise.all([collect("go"), collect("ts")]);
    const onlyGo = go.filter((l) => !ts.includes(l));
    const onlyTs = ts.filter((l) => !go.includes(l));
    if (onlyGo.length + onlyTs.length > 0)
      console.log(`ONLY GO:\n${onlyGo.join("\n")}\nONLY TS:\n${onlyTs.join("\n")}`);
    expect(ts).toEqual(go);
    expect(go.length).toBeGreaterThan(30);
  }, 60_000);

  test("a final line without a newline is dropped, as mcp-go does at EOF", async () => {
    for (const side of ["go", "ts"] as const) {
      const sb = makeSandbox("full");
      const s = new McpSession(side, { cwd: sb.dir, home: sb.home });
      s.sendRaw('{"jsonrpc":"2.0","id":1,"method":"ping"}');
      await Bun.sleep(300);
      // sendRaw appends the newline; write the unterminated line directly.
      (
        s as unknown as { proc: { stdin: { write(x: string): void; flush(): void } } }
      ).proc.stdin.write('{"jsonrpc":"2.0","id":2,"method":"ping"}');
      await s.close();
      expect(s.lines.length).toBe(1);
    }
  }, 30_000);
});
