import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/app/_components/facet";
import { Validator } from "./validator";

export const metadata: Metadata = {
  title: "NPI Validator — Check an NPI Number's Check Digit",
  description:
    "Free NPI number validator. Instantly check whether a 10-digit National Provider Identifier is valid " +
    "using its Luhn check digit — runs in your browser, no data sent. Plus how the NPI check digit works.",
  alternates: { canonical: "/tools/npi-validator" },
};

export default function NpiValidatorPage() {
  return (
    <article>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "NPI Validator", href: "/tools/npi-validator" }]} />
      <h1>NPI validator</h1>
      <p className="sub">
        Check whether a 10-digit National Provider Identifier is structurally valid. Validation runs entirely in
        your browser using the NPI check-digit algorithm, so nothing is sent anywhere.
      </p>

      <Validator />

      <section style={{ marginTop: 32 }}>
        <h2>How NPI check-digit validation works</h2>
        <p>
          An NPI is a 10-digit number whose last digit is a <strong>Luhn check digit</strong>. To validate it, the
          first 9 digits are prefixed with <code>80840</code> (the ISO issuer identifier for US health
          applications), the Luhn algorithm is run over those 14 digits, and the result must match the 10th digit.
          A number that fails this test cannot be a real NPI. Passing it only proves the number is well-formed,
          though, not that it&apos;s actually assigned to anyone. To confirm a provider exists, look it up in the{" "}
          <Link href="/">NPPES registry</Link>.
        </p>
      </section>
    </article>
  );
}
