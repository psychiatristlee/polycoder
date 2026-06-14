import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "poly search",
  description: "Self-hosted search engine — crawl your own corpus, Postgres full-text search.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
