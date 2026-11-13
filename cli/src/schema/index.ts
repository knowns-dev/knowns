import { z } from "zod";

/**
 * Boundary validation pattern: every external input (CLI args, MCP arguments,
 * HTTP bodies, files under .knowns/) is parsed with a schema before use.
 */
export function parseBoundary<T extends z.ZodType>(
  schema: T,
  input: unknown,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid ${what}: ${detail}`);
  }
  return result.data;
}

/** Example schema used by the stub CLI. */
export const cliArgsSchema = z.object({
  version: z.boolean().default(false),
  debugUiAsset: z.string().optional(),
});
export type CliArgs = z.infer<typeof cliArgsSchema>;
