import type { Metadata } from "next";
import { headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const metadataBase = host ? new URL(`${protocol}://${host}`) : undefined;

  return {
    metadataBase,
    title: "Lumen Tickets | Northstar Afterglow Tour",
    description:
      "Reserve tickets for Northstar's Afterglow Tour at Lakefront Arena in Chicago.",
    openGraph: {
      title: "Northstar — Afterglow Tour · Chicago",
      description:
        "The public ticket drop opens three minutes after arrival. Be ready.",
      type: "website",
      images: metadataBase
        ? [
            {
              url: new URL("/ticket-rush-og.png", metadataBase).toString(),
              width: 1536,
              height: 1024,
              alt: "Northstar Afterglow Tour in Chicago",
            },
          ]
        : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: "Northstar — Afterglow Tour · Chicago",
      description:
        "The public ticket drop opens three minutes after arrival. Be ready.",
      images: metadataBase
        ? [new URL("/ticket-rush-og.png", metadataBase).toString()]
        : undefined,
    },
  };
}

export default function TicketRushLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
