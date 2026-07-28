/** Cloudflare Worker entry point for the vinext-starter template. */
import handler from "vinext/server/app-router-entry";

type Env = Record<string, unknown>;

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const DISABLED_IMAGE_PATHS = new Set([
  "/_vinext/image",
  "/_vinext/image/",
]);
const NOT_FOUND_BODY = "Not Found\n";

function disabledImageResponse(method: string): Response {
  return new Response(method.toUpperCase() === "HEAD" ? null : NOT_FOUND_BODY, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (DISABLED_IMAGE_PATHS.has(url.pathname)) {
      return disabledImageResponse(request.method);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
