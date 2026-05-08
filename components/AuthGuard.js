import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useSession } from '@supabase/auth-helpers-react';

export default function AuthGuard({ children }) {
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    // If the session check is finished (not undefined) and no session exists (null)
    if (session === null) {
      router.replace('/auth');
    }
  }, [session, router]);

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
