import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p className="sub">
        We couldn&apos;t find that NPI. It may be invalid, or not present in the current NPPES release.
      </p>
      <p><Link href="/">← Search again</Link></p>
    </>
  );
}
