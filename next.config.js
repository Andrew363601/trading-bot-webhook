/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  
  // NEW: Force Vercel to bundle the raw strategy files so the AI can read them
  experimental: {
    outputFileTracingIncludes: {
      '/api/chat': ['./lib/strategies/**/*'],
      '/api/genetic-optimizer': ['./lib/strategies/**/*']
    }
  },

  // Ensure we don't have issues with top-level await or experimental features if needed
  webpack: (config) => {
    config.experiments = { ...config.experiments, topLevelAwait: true };
    return config;
  },
};

export default nextConfig;