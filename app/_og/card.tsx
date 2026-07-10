import { ImageResponse } from "next/og";

// Shared social-card renderer for per-page opengraph-image routes. next/og (satori) needs explicit
// flex layout + inline styles. Built-in default font — no font file needed (proven by the root card).
export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

export function ogCard(opts: { eyebrow?: string; title: string; subtitle?: string }) {
  const { eyebrow, title, subtitle } = opts;
  // Scale the title down a touch for very long headings so they don't overflow the card.
  const titleSize = title.length > 64 ? 52 : title.length > 40 ? 64 : 76;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #0b5fff 0%, #0942b8 100%)",
          color: "#fff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: -1, opacity: 0.85 }}>
          {eyebrow ? `NPIRadar · ${eyebrow}` : "NPIRadar"}
        </div>
        <div style={{ fontSize: titleSize, fontWeight: 800, lineHeight: 1.05, marginTop: 24 }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 34, marginTop: 28, opacity: 0.9 }}>{subtitle}</div>
        ) : null}
      </div>
    ),
    OG_SIZE,
  );
}
