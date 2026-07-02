'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface NavHeaderProps {
  sidebarOpen: boolean;
}

export default function NavHeader({ sidebarOpen }: NavHeaderProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('User');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [balance, setBalance] = useState(0);

  useEffect(() => {
    fetch('/api/profile').then(r => r.json()).then(d => {
      setDisplayName(d.displayName || 'User');
      setAvatarUrl(d.avatarUrl);
    }).catch(() => {});
    fetch('/api/tokens').then(r => r.json()).then(d => {
      setBalance(d.balance || 0);
    }).catch(() => {});
  }, []);

  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.05] bg-[#0d0d1a] shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-lg font-semibold tracking-tight">Agora</span>
      </div>

      <div className="flex items-center gap-4">
        {/* Token balance */}
        <div className="text-xs text-gray-500">
          <span className="text-gray-300 font-semibold">{balance.toLocaleString()}</span> credits
        </div>

        {/* Settings */}
        <button
          onClick={() => router.push('/settings')}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          Settings
        </button>

        {/* Avatar / name */}
        <div className="flex items-center gap-2">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover border border-white/10" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-[#253a5e] flex items-center justify-center text-xs font-bold">
              {displayName[0]?.toUpperCase() || 'U'}
            </div>
          )}
          <span className="text-sm text-gray-400">{displayName}</span>
        </div>
      </div>
    </div>
  );
}
