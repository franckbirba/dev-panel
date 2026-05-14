import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.NODE_ENV === 'production' ? 'export' : undefined,
  basePath: "/dashboard",
  assetPrefix: "/dashboard",
  trailingSlash: true,
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  async rewrites() {
    return [
      {
        source: '/dashboard/api/:path*',
        destination: 'http://localhost:3030/api/:path*',
        basePath: false,
      },
    ];
  },
};

export default nextConfig;
