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
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
  });

  it("delegates every other route unchanged", async () => {
    const expected = new Response("delegated", { status: 207 });
    mocks.handlerFetch.mockResolvedValueOnce(expected);
    const env = {};
    const request = new Request("https://preview.example.test/icons/icon-192.png");

    const response = await worker.fetch(request, env, context);

    expect(response).toBe(expected);
    expect(mocks.handlerFetch).toHaveBeenCalledOnce();
    expect(mocks.handlerFetch).toHaveBeenCalledWith(request, env, context);
  });
});
