"use client";

import Script from "next/script";
import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Matomo site 9 on the shared instance (matomo.redbudway.com). The init snippet deliberately
// doesn't trackPageView: PageView does it on mount and on every client-side navigation, so the
// first view isn't counted twice. Only JS-executing clients report, so the proxy scraper
// (which never runs JS) doesn't pollute the numbers.
const MATOMO_URL = "https://matomo.redbudway.com";
const SITE_ID = "9";

declare global {
  interface Window {
    _paq?: unknown[][];
  }
}

function PageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const qs = searchParams?.toString();
    const _paq = (window._paq = window._paq || []);
    _paq.push(["setCustomUrl", pathname + (qs ? `?${qs}` : "")]);
    _paq.push(["setDocumentTitle", document.title]);
    _paq.push(["trackPageView"]);
  }, [pathname, searchParams]);

  return null;
}

export function Matomo() {
  if (process.env.NODE_ENV !== "production") return null;
  return (
    <>
      <Script id="matomo-init" strategy="afterInteractive">
        {`var _paq = window._paq = window._paq || [];
_paq.push(['setTrackerUrl', '${MATOMO_URL}/matomo.php']);
_paq.push(['setSiteId', '${SITE_ID}']);
_paq.push(['enableLinkTracking']);
_paq.push(['enableHeartBeatTimer']);`}
      </Script>
      <Script id="matomo-js" src={`${MATOMO_URL}/matomo.js`} strategy="afterInteractive" />
      <Suspense fallback={null}>
        <PageView />
      </Suspense>
    </>
  );
}
