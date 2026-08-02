import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const description =
    "Interactive 3D exploration of gene and gene-set abundance across human brain regions and cell classes.";

  return {
    metadataBase,
    title: {
      default: "DigitalBrain Gene Atlas",
      template: "%s · DigitalBrain",
    },
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "DigitalBrain Gene Atlas",
      description,
      type: "website",
      images: [
        {
          url: new URL("/og.png", metadataBase).toString(),
          width: 1536,
          height: 1024,
          alt: "DigitalBrain Gene Atlas expression viewer",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "DigitalBrain Gene Atlas",
      description,
      images: [new URL("/og.png", metadataBase).toString()],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
