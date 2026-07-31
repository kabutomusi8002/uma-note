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

  it("keeps the production workers.dev route disabled while allowing previews", () => {
    expect(workerDeploymentConfig.workers_dev).toBe(false);
    expect(workerDeploymentConfig.preview_urls).toBe(true);
  });
});
