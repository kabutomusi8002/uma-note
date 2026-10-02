import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlerFetch: vi.fn(),
}));

vi.mock("vinext/server/app-router-entry", () => ({
  default: {
    fetch: mocks.handlerFetch,
  },
}));

import worker from "../worker/index";

const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
};

const forbiddenEnvironment = new Proxy<Record<string, unknown>>(
  {},
  {
    get() {
      throw new Error("The disabled image endpoint must not access bindings");
    },
  },
);

const expectedSecurityHeaders = {
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(expectedSecurityHeaders)) {
    expect(response.headers.get(name)).toBe(value);
  }
  expect(response.headers.has("content-security-policy")).toBe(false);
}

async function fetchImageEndpoint(
  pathname: string,
  method = "GET",
): Promise<Response> {
  return worker.fetch(
    new Request(`https://preview.example.test${pathname}`, { method }),
    forbiddenEnvironment,
    context,
  );
}

describe("disabled Vinext image optimization endpoint", () => {
  beforeEach(() => {
    mocks.handlerFetch.mockReset();
    context.waitUntil.mockReset();
    context.passThroughOnException.mockReset();
  });

  it.each([
    ["/_vinext/image", "GET"],
    ["/_vinext/image/", "GET"],
    ["/_vinext/image?url=%2Ficons%2Ficon-192.png&w=640&q=75", "GET"],
    ["/_vinext/image?url=https%3A%2F%2Fexample.test%2Fhorse.png&w=640&q=75", "GET"],
    ["/_vinext/image?url=%2Ffavicon.svg&w=640&q=75", "GET"],
    ["/_vinext/image", "POST"],
    ["/_vinext/image", "PUT"],
    ["/_vinext/image", "DELETE"],
  ])("returns a fixed 404 for %s using %s", async (pathname, method) => {
    const response = await fetchImageEndpoint(pathname, method);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expectSecurityHeaders(response);
    expect(body).toBe("Not Found\n");
    expect(body).not.toMatch(
      /stack|node_modules|binding|assets|images|secret|token|password/i,
    );
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
  });

  it("returns no response body for HEAD", async () => {
    const response = await fetchImageEndpoint("/_vinext/image?url=/og.png", "HEAD");

    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expectSecurityHeaders(response);
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["HTML", "/", "text/html; charset=utf-8", 200],
    ["static asset", "/icons/icon-192.png", "image/png", 200],
    ["error response", "/missing", "text/plain; charset=utf-8", 404],
  ])("adds security headers to a delegated %s", async (_kind, pathname, contentType, status) => {
    const expected = new Response("delegated", {
      status,
      headers: { "Content-Type": contentType },
    });
    mocks.handlerFetch.mockResolvedValueOnce(expected);
    const env = {};
    const request = new Request(`https://preview.example.test${pathname}`);

    const response = await worker.fetch(request, env, context);

    expect(response).not.toBe(expected);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(await response.text()).toBe("delegated");
    expectSecurityHeaders(response);
    expect(mocks.handlerFetch).toHaveBeenCalledOnce();
    expect(mocks.handlerFetch).toHaveBeenCalledWith(request, env, context);
  });
});
