import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useSession } from '@supabase/auth-helpers-react';
import { createClient } from '@supabase/supabase-js';

export default function AuthGuard({ children }) {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    // If the session check is finished (not undefined) and no session exists (null)
    if (session === null) {
      router.replace('/auth');
    }
  }, [session, router]);

  // 🟢 THE REAPER: 1-Hour Inactivity Session Reaper
  useEffect(() => {
    if (!session) return;

    let timeout;
    const resetTimer = () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(async () => {
            console.log("[SECURITY] Inactivity threshold reached. Reaping session...");
            const supabase = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL,
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
            );
            await supabase.auth.signOut();
            window.location.href = '/auth';
        }, 60 * 60 * 1000); // 1 hour
    };

    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, resetTimer));
    resetTimer();

    return () => {
        if (timeout) clearTimeout(timeout);
        events.forEach(e => window.removeEventListener(e, resetTimer));
    };
  }, [session]);

  // Show a loading screen while session is being determined (undefined)
  if (session === undefined) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  // Only render children if we have a valid session
  return session ? children : null;
}
