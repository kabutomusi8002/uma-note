import { describe, expect, it } from "vitest";
import { repositoryError } from "@/lib/supabase/repository-error";
import { classifySyncError } from "@/lib/sync/outbox";

describe("repositoryError", () => {
  it("keeps browser transport failures retryable", () => {
    const error = repositoryError("load failed", { message: "Failed to fetch" });

    expect(error).toMatchObject({ code: "network_error", status: 0 });
    expect(classifySyncError(error).kind).toBe("retryable");
  });

  it("stops for expired JWT and RLS authorization failures", () => {
    const jwt = repositoryError("load failed", {
      message: "JWT expired",
      code: "PGRST301",
    });
    const rls = repositoryError("write failed", {
      message: "new row violates row-level security policy",
      code: "42501",
    });

    expect(jwt).toMatchObject({ status: 401 });
    expect(rls).toMatchObject({ status: 403 });
    expect(classifySyncError(jwt).kind).toBe("auth");
    expect(classifySyncError(rls).kind).toBe("auth");
  });

  it("does not retry acknowledged validation errors indefinitely", () => {
    const error = repositoryError("write failed", {
      message: "invalid input syntax",
      code: "22P02",
    });

    expect(error).toMatchObject({ status: 400 });
    expect(classifySyncError(error).kind).toBe("permanent");
  });

  it("classifies transient database failures and uniqueness conflicts", () => {
    const unavailable = repositoryError("write failed", {
      message: "serialization failure",
      code: "40001",
    });
    const duplicate = repositoryError("write failed", {
      message: "duplicate key value violates unique constraint",
      code: "23505",
    });

    expect(unavailable).toMatchObject({ status: 503 });
    expect(duplicate).toMatchObject({ status: 409 });
    expect(classifySyncError(unavailable).kind).toBe("retryable");
    expect(classifySyncError(duplicate).kind).toBe("conflict");
  });
});
