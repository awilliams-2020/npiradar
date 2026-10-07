import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/app/_components/facet";
import { dataVintage } from "@/lib/facets";

// Static at build (no DB there), so re-render daily to swap the fallback vintage label for the real one.
export const revalidate = 86400;

// Who runs the site and how to reach them. Contact is LinkedIn, not email (the domain has no mailbox),
// matching theqrcode.io/about and redbudway.com/about; the photo is redbudway's public/adam-williams.webp.
// /contact, /contact-us and /about-us redirect here (next.config.mjs).
const FOUNDER = {
  name: "Adam Williams",
  role: "Founder & software engineer",
  photo: "/adam-williams.webp",
  linkedin: "https://www.linkedin.com/in/awilliams1989",
};

export const metadata: Metadata = {
  title: "About NPIRadar — Who Runs It and How to Get in Touch",
  description:
    "NPIRadar is an independent NPI lookup built and run by Adam Williams, a software engineer. Where the data " +
    "comes from, how to correct a provider listing, and how to get in touch.",
  alternates: { canonical: "/about" },
};

export default async function AboutPage() {
  const vintage = await dataVintage();
  const orgJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "NPIRadar",
    url: "https://npiradar.com",
    founder: {
      "@type": "Person",
      name: FOUNDER.name,
      jobTitle: FOUNDER.role,
      image: `https://npiradar.com${FOUNDER.photo}`,
      sameAs: [FOUNDER.linkedin],
    },
  });

  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: orgJsonLd }} />
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "About", href: "/about" }]} />
      <h1>About NPIRadar</h1>

      <div className="founder">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={FOUNDER.photo} alt={FOUNDER.name} width={120} height={120} />
        <div>
          <p className="founder-name">{FOUNDER.name}</p>
          <p className="muted">{FOUNDER.role}</p>
          <a href={FOUNDER.linkedin} target="_blank" rel="noopener noreferrer me">
            Connect on LinkedIn
          </a>
        </div>
      </div>

      <section style={{ marginTop: 32 }}>
        <h2>Who&apos;s behind it</h2>
        <p>
          NPIRadar is built and run by me, {FOUNDER.name}, a software engineer. There&apos;s no company behind it
          and no sales team. I built it because the official NPI Registry is hard to browse: you can look up one
          provider at a time, but you can&apos;t easily see who practices a given specialty in a given city.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Where the data comes from</h2>
        <p>
          Every listing comes from the public NPPES Downloadable File published by CMS (currently the {vintage}).
          NPIRadar doesn&apos;t add, edit, or sell provider data. It republishes the public record as a directory,
          along with free tools like the <Link href="/tools/npi-validator">NPI validator</Link>,{" "}
          <Link href="/tools/bulk-lookup">bulk lookup</Link>, and the <Link href="/npi-api">NPI API</Link>. See{" "}
          <Link href="/nppes">NPPES explained</Link> for what the registry contains. NPIRadar is not affiliated with
          or endorsed by CMS.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Is your listing wrong or out of date?</h2>
        <p>
          Your NPIRadar listing mirrors your NPPES record, so the fix is to update NPPES itself. Providers can sign
          in at <a href="https://nppes.cms.hhs.gov/" target="_blank" rel="noopener noreferrer">nppes.cms.hhs.gov</a>{" "}
          to change their address, phone, or specialty. The change appears here after the next data load.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Get in touch</h2>
        <p>
          Found a bug, have a question about the API, or need something that doesn&apos;t look right? Message me
          on <a href={FOUNDER.linkedin} target="_blank" rel="noopener noreferrer me">LinkedIn</a>. I read every
          message.
        </p>
      </section>
    </article>
  );
}
