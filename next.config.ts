import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.PLANNER_TEST_BUILD === "demo" ? ".next-demo-test" : process.env.PLANNER_TEST_BUILD === "product" ? ".next-product-test" : ".next",
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
      ]
    }];
  }
};

export default nextConfig;
