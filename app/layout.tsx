import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "UNSEEN — Search every moment. See the whole squad story.";
const description =
  "Search long gameplay naturally, jump to evidence-cited moments, create highlight reels, and reconstruct the story across every squad perspective.";

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
      images: [{ url: socialImage, width: 1730, height: 909, alt: "UNSEEN gameplay search, evidence timeline, and squad story" }],
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
