// Port of internal/lsp/binary_override.go.
import type { Binary, BinaryCandidate } from "./types.ts";

export function invalidBinaryOverride(override: string): Error {
  return new Error(
    `binary override ${JSON.stringify(override)} must match a registered language-server binary`,
  );
}

export function selectBinaryCandidateOverride(
  override: string,
  candidates: BinaryCandidate[],
): BinaryCandidate {
  if (override.trim() !== override || override === "") throw invalidBinaryOverride(override);
  const found = candidates.find((c) => c.name === override);
  if (!found) throw invalidBinaryOverride(override);
  return found;
}

export function selectBinaryOverride(override: string, candidates: Binary[]): Binary {
  if (override.trim() !== override || override === "") throw invalidBinaryOverride(override);
  const found = candidates.find((c) => c.name === override);
  if (!found) throw invalidBinaryOverride(override);
  return found;
}
