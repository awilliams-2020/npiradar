/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone server for the Docker image (~/projects/npiradar compose).
  output: "standalone",
  // pg + ioredis are server-only deps; keep them external to the traced server bundle.
  serverExternalPackages: ["pg", "ioredis"],
};

export default nextConfig;
