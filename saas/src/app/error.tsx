'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { console.error('Page error:', error); }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#0d0d1a]">
      <div className="text-center max-w-md">
        <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
        <p className="text-sm text-gray-400 mb-6">{error.message}</p>
        <div className="flex gap-3 justify-center">
          <button onClick={reset} className="px-5 py-2.5 rounded-xl bg-[#1a3a5c] hover:bg-[#22507a] font-semibold transition-colors">
            Try Again
          </button>
          <Link href="/chat" className="px-5 py-2.5 rounded-xl border border-gray-600 hover:border-gray-400 font-semibold transition-colors">
            Go to Chat
          </Link>
        </div>
      </div>
    </div>
  );
}
