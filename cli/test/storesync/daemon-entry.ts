// The TypeScript daemon entry for tests: the real CLI with store sync wired in, as main will wire it
// through installWiring. Spawned as `bun daemon-entry.ts __runtime run`.

import { run } from "../../src/main.ts";
import { installStoreSync } from "../../src/wiring/storesync.ts";

installStoreSync();
process.exit(await run(process.argv.slice(2)));
