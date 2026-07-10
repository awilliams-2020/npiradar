import { ImageResponse } from "next/og";

// Default social card for all pages (Next auto-wires og:image + twitter:image from this file).
export const alt = "NPIRadar — NPI lookup & provider directory";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
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
        <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1, opacity: 0.85 }}>NPIRadar</div>
        <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, marginTop: 24 }}>
          Look up any US healthcare provider by NPI
        </div>
        <div style={{ fontSize: 34, marginTop: 28, opacity: 0.9 }}>
          9.5M+ providers · specialty · practice location · from the public NPPES registry
        </div>
      </div>
    ),
    size,
  );
}
