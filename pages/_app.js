import '../styles/globals.css';

/**
 * MASTER WRAPPER
 * ----------------------------
 * Cleaned up to avoid multiple export errors during Vercel builds.
 */
export default function MyApp({ Component, pageProps }) {
  return <Component {...pageProps} />;
}