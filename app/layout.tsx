import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegister } from "./components/service-worker-register";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  applicationName: "UMA NOTE",
  title: {
    default: "UMA NOTE｜競馬予想・収支管理",
    template: "%s｜UMA NOTE",
  },
  description:
    "予想を組み立て、発走前に固定し、実購入・結果・反省まで一つにつなぐ競馬ノートPWA。",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "UMA NOTE",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/icon-192.png",
  },
  openGraph: {
    type: "website",
    locale: "ja_JP",
    siteName: "UMA NOTE",
    title: "UMA NOTE｜競馬予想・収支管理",
    description: "予想、買い目、実購入、結果、反省を一つの流れで管理。",
    images: [
      {
        url: "/og.png",
        width: 1734,
        height: 907,
        alt: "UMA NOTE — 予想と収支を、発走前の判断から。",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#153f35",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
      </head>
      <body>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
