export interface RepositoryErrorLike {
  message: string;
  code?: string | null;
  status?: number | null;
  statusCode?: number | null;
}

/**
 * Preserve enough transport/PostgREST information for the durable Outbox to
 * distinguish authentication, conflicts, transient failures, and permanent
 * request errors. Supabase's PostgREST errors do not consistently expose an
 * HTTP status in browser builds, so PostgreSQL/PostgREST codes are normalized.
 */
export function repositoryError(prefix: string, error: RepositoryErrorLike): Error {
  const code = error.code?.trim() ?? "";
  const message = error.message.trim();
  const explicitStatus = Number(error.status ?? error.statusCode ?? 0);
  const networkFailure =
    !code &&
    /failed to fetch|fetch failed|network(?: request)? failed|load failed|connection (?:failed|reset)|timed? out/i.test(
      message,
    );
  const authenticationFailure =
    code === "PGRST301" ||
    code === "PGRST302" ||
    code === "28000" ||
    code === "28P01" ||
    /jwt.*(?:expired|invalid)|invalid.*jwt/i.test(message);
  const authorizationFailure = code === "42501";
  const conflictFailure = code === "23505" || code === "23P01";
  const retryableServerFailure =
    code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    code === "58030" ||
    /^08/.test(code) ||
    /^53/.test(code) ||
    /^57P0[123]$/.test(code) ||
    /^PGRST00[0-3]$/.test(code);
  const normalizedStatus = networkFailure
    ? 0
    : authenticationFailure
      ? 401
      : authorizationFailure
        ? 403
        : conflictFailure
          ? 409
          : retryableServerFailure
            ? 503
            : Number.isFinite(explicitStatus) && explicitStatus >= 400
              ? explicitStatus
              : 400;

  return Object.assign(new Error(`${prefix}: ${error.message}`), {
    code: code || (networkFailure ? "network_error" : "repository_error"),
    status: normalizedStatus,
  });
}
