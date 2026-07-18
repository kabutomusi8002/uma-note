import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
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
}
