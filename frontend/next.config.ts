import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root also holds an empty package-lock.json, which made Next infer the wrong workspace root. The app lives in this folder, so say so.
  turbopack: { root: path.resolve(__dirname) },
};

export default nextConfig;
