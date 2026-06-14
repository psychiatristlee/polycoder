/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg + cloud-sql-connector are native server deps — keep them external to the bundle.
  serverExternalPackages: ["pg", "@google-cloud/cloud-sql-connector"],
};
module.exports = nextConfig;
