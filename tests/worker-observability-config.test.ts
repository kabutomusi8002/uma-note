import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  workerDeploymentConfig,
  workerObservabilityConfig,
} from "../vite.config";

describe("Cloudflare Worker observability configuration", () => {
  it("enables Workers Logs without recording invocation URLs", () => {
    expect(workerObservabilityConfig).toEqual({
      enabled: true,
      logs: {
        invocation_logs: false,
      },
    });
    expect(workerDeploymentConfig.observability).toBe(
      workerObservabilityConfig,
    );
  });

  it("disables both workers.dev and preview URLs", () => {
    expect(workerDeploymentConfig.workers_dev).toBe(false);
    expect(workerDeploymentConfig.preview_urls).toBe(false);
  });

  it("adds the security headers to Cloudflare static assets", () => {
    const headers = readFileSync(
      fileURLToPath(new URL("../public/_headers", import.meta.url)),
      "utf8",
    );
    expect(headers).toContain("/*");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("Referrer-Policy: strict-origin-when-cross-origin");
    expect(headers).toContain(
      "Permissions-Policy: camera=(), microphone=(), geolocation=()",
    );
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(headers).not.toContain("Content-Security-Policy");
  });
});
