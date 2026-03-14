/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    // Ensure we don't have issues with top-level await or experimental features if needed
    webpack: (config) => {
      config.experiments = { ...config.experiments, topLevelAwait: true };
      return config;
    },
  };
  
  export default nextConfig;