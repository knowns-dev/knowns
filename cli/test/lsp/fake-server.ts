// A tiny stdio language server for tests: symbols for every file, definition at 0:0.
let buf = Buffer.alloc(0);
function send(msg: unknown): void {
  const data = Buffer.from(JSON.stringify(msg));
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`), data]),
  );
}
const range = (l: number) => ({ start: { line: l, character: 0 }, end: { line: l, character: 5 } });
process.stdin.on("data", (d: Buffer) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const he = buf.indexOf("\r\n\r\n");
    if (he < 0) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buf.subarray(0, he).toString())?.[1]);
    if (buf.length < he + 4 + len) return;
    const msg = JSON.parse(buf.subarray(he + 4, he + 4 + len).toString());
    buf = buf.subarray(he + 4 + len);
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          capabilities: {
            documentSymbolProvider: true,
            definitionProvider: true,
            referencesProvider: {},
          },
        },
      });
    } else if (msg.method === "textDocument/documentSymbol") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: [
          {
            name: "Widget",
            kind: 5,
            detail: "class",
            range: range(0),
            selectionRange: range(0),
            children: [{ name: "render", kind: 6, range: range(1), selectionRange: range(1) }],
          },
        ],
      });
    } else if (msg.method === "textDocument/definition") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { uri: msg.params.textDocument.uri, range: range(0) },
      });
    } else if (msg.method === "textDocument/references") {
      send({ jsonrpc: "2.0", id: msg.id, result: [] });
    } else if (msg.method === "shutdown") {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "exit") {
      process.exit(0);
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
});
