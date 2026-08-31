import type { NextConfig } from 'next';

import { computeSourceBuildId } from './scripts/sourceBuildId';

// Runtime response headers are applied by worker.ts. Vinext beta currently
// ignores Next's headers() hook for streamed App Router responses.
const sourceBuildId = computeSourceBuildId();

const nextConfig: NextConfig = {
  output: 'standalone',
  generateBuildId: () => sourceBuildId,
  deploymentId: sourceBuildId,
};

export default nextConfig;
