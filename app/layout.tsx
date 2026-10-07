import type { Metadata } from "next";
import Link from "next/link";
import { dataVintage } from "@/lib/facets";
import { Matomo } from "./_components/matomo";
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
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
            <nav className="footer-links" aria-label="Footer">
              <div>
                <strong>Look up</strong>
                <Link href="/search">Search providers</Link>
                <Link href="/specialty">Specialties</Link>
                <Link href="/tools/bulk-lookup">Bulk NPI lookup</Link>
                <Link href="/tools/npi-validator">NPI validator</Link>
              </div>
              <div>
                <strong>Check</strong>
                <Link href="/oig-exclusion-check">OIG exclusion check</Link>
                <Link href="/open-payments">Open Payments lookup</Link>
              </div>
              <div>
                <strong>Learn</strong>
                <Link href="/nppes">NPPES and the NPI Registry</Link>
                <Link href="/npi-api">Free NPI API</Link>
                <Link href="/about">About &amp; contact</Link>
              </div>
            </nav>
            <p>
              Data: {await dataVintage()}, a public-domain dataset from CMS. NPIRadar is not affiliated with
              or endorsed by CMS.
            </p>
          </div>
        </footer>
        <Matomo />
      </body>
    </html>
  );
}
