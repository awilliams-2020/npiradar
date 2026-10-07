/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone server for the Docker image (~/projects/npiradar compose).
  output: "standalone",
  // pg + ioredis are server-only deps; keep them external to the traced server bundle.
  serverExternalPackages: ["pg", "ioredis"],
  // Visitors (and agents) probe these looking for a way to reach us; /about carries the contact.
  async redirects() {
    return ["/contact", "/contact-us", "/about-us"].map((source) => ({
      source,
      destination: "/about",
      permanent: true,
    }));
  },
};

export default nextConfig;
