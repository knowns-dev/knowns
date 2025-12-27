#!/usr/bin/env node
/**
 * Post-build script to replace bun shebang with node shebang
 * for cross-platform compatibility (especially Windows)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = [
  join(import.meta.dirname, "..", "dist", "index.js"),
  join(import.meta.dirname, "..", "dist", "mcp", "server.js"),
];

const oldShebang = "#!/usr/bin/env bun";
const newShebang = "#!/usr/bin/env node";

for (const file of files) {
  try {
    let content = readFileSync(file, "utf-8");
    if (content.startsWith(oldShebang)) {
      content = content.replace(oldShebang, newShebang);
      // Also remove the @bun comment
      content = content.replace(/^\/\/ @bun\n/m, "");
      writeFileSync(file, content);
      console.log(`✓ Fixed shebang in ${file}`);
    } else {
      console.log(`⊘ Shebang already correct in ${file}`);
    }
  } catch (error) {
    console.error(`✗ Failed to process ${file}: ${error.message}`);
  }
}
