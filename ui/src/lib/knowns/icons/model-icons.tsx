import type { ReactNode } from "react";
import { MODEL_SVGS } from "./model-icons.data";

/** Logo wrapper: fills its box; monochrome logos follow the text colour. */
export const LOGO = "grid size-full place-items-center text-foreground [&>svg]:size-full";

/** Model name pattern → provider logo (SVGs generated from @lobehub/icons-static-svg, MIT). */
const RULES: [RegExp, string][] = [
  [/claude|opus|sonnet|haiku|fable|anthropic/i, "claude"],
  [/\bgpt|\bo[1-9]\b|openai|codex|chatgpt/i, "openai"],
  [/gemini|gemma/i, "gemini"],
  [/llama|\bmeta\b/i, "meta"],
  [/mistral|mixtral|codestral|magistral|devstral/i, "mistral"],
  [/deepseek/i, "deepseek"],
  [/qwen|qwq/i, "qwen"],
  [/grok|\bxai\b/i, "grok"],
  [/kimi|moonshot/i, "kimi"],
  [/cohere|command[- ]?r/i, "cohere"],
  [/perplexity|sonar/i, "perplexity"],
  [/glm|zhipu/i, "zhipu"],
  [/minimax|abab/i, "minimax"],
];

/** Provider logo for a model name such as "Sonnet 5.5" or "GPT-5", or null if unknown. */
export function modelIcon(model?: string): ReactNode | null {
  if (!model) return null;
  const hit = RULES.find(([re]) => re.test(model));
  if (!hit) return null;
  // Trusted, bundled SVG markup - inlined so monochrome logos follow currentColor.
  return <span className={LOGO} dangerouslySetInnerHTML={{ __html: MODEL_SVGS[hit[1]] }} />;
}
