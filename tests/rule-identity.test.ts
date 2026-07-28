import { describe, expect, it } from "vitest";
import { ruleIdentityKey } from "../lib/rule-identity";

describe("rule identity", () => {
  it("matches PostgreSQL's trimmed, case-sensitive logical identity", () => {
    expect(ruleIdentityKey({ name: " Rule ", version: " 1.0 " })).toBe(
      ruleIdentityKey({ name: "Rule", version: "1.0" }),
    );
    expect(ruleIdentityKey({ name: "Rule", version: "1.0" })).not.toBe(
      ruleIdentityKey({ name: "rule", version: "1.0" }),
    );
  });
});
