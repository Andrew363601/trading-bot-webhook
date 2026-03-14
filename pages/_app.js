import '../styles/globals.css';

/**
 * MASTER WRAPPER: pages/_app.js
 * ----------------------------
 * This is the root component of your application. 
 * By importing globals.css here, we ensure that Tailwind's styles 
 * are applied to every page, including your index.js dashboard.
 */
export default function MyApp({ Component, pageProps }) {
  return <Component {...pageProps} />;
}