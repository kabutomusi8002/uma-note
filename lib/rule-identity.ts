import type { PredictionRuleVersion } from "./types";

/** Mirrors PostgreSQL's btrim + case-sensitive rule name/version identity. */
export function ruleIdentityKey(
  rule: Pick<PredictionRuleVersion, "name" | "version">,
): string {
  return JSON.stringify([rule.name.trim(), rule.version.trim()]);
}
