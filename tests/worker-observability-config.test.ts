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

  it("does not change workers.dev routing from source configuration", () => {
    expect(workerDeploymentConfig).not.toHaveProperty("workers_dev");
  });
});
