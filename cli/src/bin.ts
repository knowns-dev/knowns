// Entry point for the compiled binary. It always runs, unlike the `import.meta.main` guard in
// main.ts: Bun.build({ compile }) on Windows (Bun 1.3.13) produces a binary in which
// import.meta.main is false, so a guarded entry silently exits 0 with no output.
// `bun src/main.ts` stays the dev entry; scripts/build.ts compiles this file.
import { run } from "./main.ts";

process.exit(await run(process.argv.slice(2)));
