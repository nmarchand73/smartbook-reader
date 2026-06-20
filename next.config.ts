import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // jszip needs to run client-side only
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'jszip'];
    }
    return config;
  },
};

export default nextConfig;
