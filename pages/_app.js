import '../styles/globals.css';
import { createPagesBrowserClient } from '@supabase/auth-helpers-nextjs';
import { SessionContextProvider } from '@supabase/auth-helpers-react';
import { useState } from 'react';
import { Analytics } from '@vercel/analytics/next';

export default function MyApp({ Component, pageProps }) {
  const [supabaseClient] = useState(() => createPagesBrowserClient());

  return (
    <SessionContextProvider
      supabaseClient={supabaseClient}
      initialSession={pageProps.initialSession}
    >
      <div className="bg-[#020617] min-h-screen selection:bg-indigo-500/30">
        <Component {...pageProps} />
      </div>
      <Analytics />
    </SessionContextProvider>
  );
}