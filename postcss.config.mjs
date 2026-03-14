/**
 * PostCSS Config (MJS)
 * -------------------
 * Using .mjs extension is the most reliable way to fix the 
 * "must export a plugins key" error in Next.js 14 + ESM projects.
 */
const config = {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  };
  
  export default config;