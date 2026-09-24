import type { Metadata } from "next";
import Link from "next/link";
import { DATA_VINTAGE } from "@/lib/format";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NPIRadar — NPI lookup & provider directory", template: "%s" },
  description:
    "Look up any US healthcare provider by NPI number. Specialty, practice location, and registry details from the public NPPES dataset.",
  metadataBase: new URL("https://npiradar.com"),
  applicationName: "NPIRadar",
  openGraph: {
    type: "website",
    siteName: "NPIRadar",
    locale: "en_US",
    url: "https://npiradar.com",
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <div className="container">
            <Link href="/" className="brand">NPIRadar</Link>
            <nav>
              <Link href="/search">Search</Link>
              <Link href="/specialty">Specialties</Link>
              <Link href="/tools/bulk-lookup">Bulk lookup</Link>
              <Link href="/tools/npi-validator">Validator</Link>
              <Link href="/npi-api">API</Link>
            </nav>
          </div>
        </header>
        <main className="container">{children}</main>
        <footer className="site">
          <div className="container">
            <p>
              Data: {DATA_VINTAGE}, a public-domain dataset from CMS. NPIRadar is not affiliated with
              or endorsed by CMS.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
