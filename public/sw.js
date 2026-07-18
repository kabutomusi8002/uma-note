const CACHE_PREFIX = "uma-note-static";
const CACHE_VERSION = "v2";
const STATIC_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const APP_SHELL_KEY = "/__uma_note_app_shell__";

// Only public, non-user-specific files belong in the precache.
const PRECACHE_URLS = [
  "/",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.webmanifest",
];

const OFFLINE_DOCUMENT = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="theme-color" content="#123629" />
    <title>オフライン | 競馬予想・収支ノート</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        color: #17372c;
        background: #f4efe4;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(100%, 420px);
        padding: 28px;
        border: 1px solid #d6ccba;
        border-radius: 24px;
        background: #fffdf8;
        box-shadow: 0 20px 50px rgb(18 54 41 / 12%);
      }
      h1 { margin: 0 0 12px; font-size: 1.5rem; }
      p { margin: 0; line-height: 1.75; color: #52645e; }
      button {
        width: 100%;
        margin-top: 24px;
        padding: 14px 18px;
        border: 0;
        border-radius: 999px;
        color: white;
        background: #123629;
        font: inherit;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>現在オフラインです</h1>
      <p>初回表示に必要なファイルをまだ保存できていません。接続を確認して再読み込みしてください。通常は端末へ自動保存した予想・購入・収支をオフラインでも確認できます。</p>
      <button type="button" onclick="location.reload()">再読み込み</button>
    </main>
  </body>
</html>`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith(CACHE_PREFIX) && key !== STATIC_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // The server-rendered document is a public app shell. User records live in
  // localStorage/Supabase and are not embedded in this cached response.
  if (request.mode === "navigate") {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            await cache.put(APP_SHELL_KEY, response.clone());
          }
          return response;
        } catch {
          return (await cache.match(APP_SHELL_KEY)) ??
            (await cache.match("/")) ??
            new Response(OFFLINE_DOCUMENT, {
            status: 503,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
            });
        }
      }),
    );
    return;
  }

  const isBuildAsset =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/assets/");
  const isPublicAsset =
    url.pathname.startsWith("/icons/") ||
    PRECACHE_URLS.includes(url.pathname);

  if (!isBuildAsset && !isPublicAsset) {
    return;
  }

  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const fromNetwork = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            void cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached ?? Response.error());

      if (cached) {
        event.waitUntil(fromNetwork);
        return cached;
      }

      return fromNetwork;
    }),
  );
});
