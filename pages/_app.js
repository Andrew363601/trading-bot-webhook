import '../styles/globals.css';
export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}

/**
 * MASTER WRAPPER: pages/_app.js
 * ----------------------------
 * This is the root component of your application. 
 * By importing globals.css here, we ensure that Tailwind's styles 
 * are applied to every page, including your index.js dashboard.
 */
function MyApp({ Component, pageProps }) {
  return <Component {...pageProps} />;
}

export default MyApp;