import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const layoutPath = fileURLToPath(new URL("../app/layout.tsx", import.meta.url));
const manifestModulePath = fileURLToPath(
  new URL("../app/manifest.ts", import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL("../public/manifest.webmanifest", import.meta.url),
);
const serviceWorkerPath = fileURLToPath(
  new URL("../public/sw.js", import.meta.url),
);

const expectedManifest = {
  name: "競馬予想・収支ノート",
  short_name: "競馬ノート",
  description:
    "レース前の予想、実購入、結果、振り返りを一つにつなぐ競馬予想・収支管理PWA",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f4efe4",
  theme_color: "#123629",
  orientation: "portrait-primary",
  lang: "ja",
  categories: ["sports", "finance", "productivity"],
  icons: [
    {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

describe("same-origin PWA manifest", () => {
  it("moves the complete manifest to a valid static JSON asset", () => {
    expect(existsSync(manifestModulePath)).toBe(false);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toEqual(expectedManifest);
    expect(manifest).not.toHaveProperty("id");
  });

  it("renders exactly one explicit root-relative manifest link", () => {
    const layout = readFileSync(layoutPath, "utf8");
    const manifestLinks =
      layout.match(
        /<link\s+rel=["']manifest["']\s+href=["']\/manifest\.webmanifest["']\s*\/>/g,
      ) ?? [];

    expect(manifestLinks).toHaveLength(1);
    expect(layout).not.toMatch(/\bmanifest\s*:/);
    expect(layout).not.toContain("uma-note-pwa-preview");
    expect(layout).not.toContain(
      "uma-note-pwa.hiromasa1019yasu.workers.dev/manifest.webmanifest",
    );
  });

  it("keeps production metadata resolution separate from the manifest link", () => {
    const layout = readFileSync(layoutPath, "utf8");

    expect(layout).toContain(
      'metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000")',
    );
    expect(layout).toContain('url: "/og.png"');
    expect(layout).toContain('images: ["/og.png"]');
  });

  it("keeps manifest assets same-origin and available in the public directory", () => {
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as typeof expectedManifest;

    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.icons.every((icon) => icon.src.startsWith("/"))).toBe(
      true,
    );
    expect(existsSync(`${root}/public/icons/icon-192.png`)).toBe(true);
    expect(existsSync(`${root}/public/icons/icon-512.png`)).toBe(true);
  });

  it("keeps the manifest in the existing Service Worker precache", () => {
    const serviceWorker = readFileSync(serviceWorkerPath, "utf8");

    expect(serviceWorker).toContain('"/manifest.webmanifest"');
    expect(serviceWorker).toContain('const CACHE_VERSION = "v2"');
  });
});
