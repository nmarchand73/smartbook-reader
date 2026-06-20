import type { NextConfig } from 'next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const isGitHubPages = process.env.GITHUB_PAGES === 'true';

const nextConfig: NextConfig = {
  ...(isGitHubPages
    ? {
        output: 'export' as const,
        basePath: '/smartbook-reader',
        assetPrefix: '/smartbook-reader/',
        trailingSlash: true,
      }
    : {}),
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
