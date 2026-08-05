import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "UNSEEN — The whole squad story";
const description =
  "UNSEEN reconstructs a multiplayer gaming session across every squad perspective, revealing the moments no single player saw.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost ?? requestHeaders.get("host") ?? "localhost:3000";
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol = forwardedProtocol ?? (host.startsWith("localhost") ? "http" : "https");

  let metadataBase = new URL("http://localhost:3000");
  try {
    metadataBase = new URL(`${protocol}://${host}`);
  } catch {
    // Keep local metadata valid if an intermediary supplies a malformed host.
  }

  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title,
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      title,
      description,
      images: [{ url: socialImage, width: 1730, height: 909, alt: "UNSEEN — The story no single player saw" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#07080b",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
