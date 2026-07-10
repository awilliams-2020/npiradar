/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone server for the Docker image (~/projects/npiradar compose).
  output: "standalone",
  // pg is a server-only native-ish dep; keep it external to the server bundle.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
