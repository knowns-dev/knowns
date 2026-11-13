// Port of internal/codegen: the Handlebars-flavoured code-generation template engine and the Go
// text/template subset it runs on. No CLI imports; usable from the CLI, MCP and server alike.
export { Engine, preprocessHandlebars, preprocessHBSExpr, TemplateRunError } from "./engine.ts";
export { GoExecError } from "./goexec.ts";
export { GoTemplateError } from "./goparse.ts";
export { goQuote } from "./goquote.ts";
export {
  camelCase,
  kebabCase,
  lowerCase,
  pascalCase,
  snakeCase,
  startCase,
  upperCase,
} from "./helpers.ts";
