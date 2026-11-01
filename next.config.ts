import type { NextConfig } from 'next';

import { computeSourceBuildId } from './scripts/sourceBuildId';

// Runtime response headers are applied by worker.ts so streamed App Router
// responses and static assets share the same restrictive policy.
const sourceBuildId = computeSourceBuildId();

const nextConfig: NextConfig = {
  output: 'standalone',
  generateBuildId: () => sourceBuildId,
  deploymentId: sourceBuildId,
};

export default nextConfig;
