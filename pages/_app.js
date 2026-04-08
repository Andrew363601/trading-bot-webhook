import '../styles/globals.css';

/**
 * MASTER WRAPPER: pages/_app.js
 * ----------------------------
 * This file is essential. If it doesn't import globals.css,
 * the dashboard will look like a plain white page.
 */
export default function MyApp({ Component, pageProps }) {
  return (
    <div className="bg-[#020617] min-h-screen selection:bg-indigo-500/30">
      <Component {...pageProps} />
    </div>
  );
}