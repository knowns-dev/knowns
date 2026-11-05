// Port of internal/lsp/adapters/adapters.go: the built-in adapters, in Go's order.
import type { LanguageAdapter } from "../types.ts";
import { newBashAdapter } from "./bash.ts";
import { newClangdAdapter } from "./cpp.ts";
import { newRoslynAdapter } from "./csharp.ts";
import { newDartAdapter } from "./dart.ts";
import { newGoAdapter } from "./go.ts";
import { newJdtlsAdapter } from "./java.ts";
import { newJSONAdapter } from "./json.ts";
import { newMarksmanAdapter } from "./markdown.ts";
import { newIntelephenseAdapter } from "./php.ts";
import { newPythonAdapter } from "./python.ts";
import { newRubyLspAdapter } from "./ruby.ts";
import { newRustAnalyzerAdapter } from "./rust.ts";
import { newScssAdapter } from "./scss.ts";
import { newSwiftAdapter } from "./swift.ts";
import { newTerraformLSAdapter } from "./terraform.ts";
import { newTypeScriptAdapter } from "./typescript.ts";
import { newYAMLAdapter } from "./yaml.ts";

export {
  newBashAdapter,
  newClangdAdapter,
  newDartAdapter,
  newGoAdapter,
  newIntelephenseAdapter,
  newJdtlsAdapter,
  newJSONAdapter,
  newMarksmanAdapter,
  newPythonAdapter,
  newRoslynAdapter,
  newRubyLspAdapter,
  newRustAnalyzerAdapter,
  newScssAdapter,
  newSwiftAdapter,
  newTerraformLSAdapter,
  newTypeScriptAdapter,
  newYAMLAdapter,
};

/** AllAdapters returns all built-in language adapters. */
export function allAdapters(): LanguageAdapter[] {
  return [
    newGoAdapter(),
    newTypeScriptAdapter(),
    newPythonAdapter(),
    newRustAnalyzerAdapter(),
    newClangdAdapter(),
    newJdtlsAdapter(),
    newRoslynAdapter(),
    newDartAdapter(),
    newSwiftAdapter(),
    newRubyLspAdapter(),
    newIntelephenseAdapter(),
    newScssAdapter(),
    newMarksmanAdapter(),
    newBashAdapter(),
    newJSONAdapter(),
    newTerraformLSAdapter(),
    newYAMLAdapter(),
  ];
}

/** All returns all built-in language adapters supported by the LSP CLI. */
export function all(): LanguageAdapter[] {
  return allAdapters();
}

/** Find returns the adapter for id. */
export function find(id: string): LanguageAdapter | undefined {
  return allAdapters().find((a) => a.id() === id);
}
