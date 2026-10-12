import type { NextConfig } from 'next';

const config: NextConfig = {
  // core is a workspace package (never published); the dashboard uses its built dist.
  transpilePackages: ['@tossana/agents-core'],
};

export default config;
