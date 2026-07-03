'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

const PROVIDER_ORDER = ['openai', 'anthropic', 'gemini', 'grok', 'deepseek'];
const PROVIDER_LABELS: Record<string, { name: string; model: string; color: string }> = {
  openai: { name: 'Chad', model: 'ChatGPT', color: '#5B9BD5' },
  anthropic: { name: 'Clarence', model: 'Claude', color: '#BF8F4A' },
  gemini: { name: 'Jenny', model: 'Gemini', color: '#70AD47' },
  grok: { name: 'Gwen', model: 'Grok', color: '#9B59B6' },
  deepseek: { name: 'Derrick', model: 'DeepSeek', color: '#E56060' },
};

const TOKEN_PACKAGES = [
  { tier: 'small', label: '5,000 Credits', price: '$5', usd: 5 },
  { tier: 'medium', label: '17,000 Credits', price: '$15', usd: 15, bonus: '+2,000 bonus' },
  { tier: 'large', label: '36,000 Credits', price: '$30', usd: 30, bonus: '+6,000 bonus' },
];

export default function SettingsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [balance, setBalance] = useState(0);
  const [keys, setKeys] = useState<any[]>([]);
  const [newKeyInputs, setNewKeyInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push('/login'); return; }

      const [profileRes, keysRes, tokensRes] = await Promise.all([
        fetch('/api/profile'),
        fetch('/api/keys'),
        fetch('/api/tokens'),
      ]);

      const profile = await profileRes.json();
      setDisplayName(profile.displayName || '');
      setAvatarUrl(profile.avatarUrl || '');

      const keysData = await keysRes.json();
      setKeys(Array.isArray(keysData) ? keysData : []);

      const tokensData = await tokensRes.json().catch(() => ({ balance: 0 }));
      setBalance(tokensData.balance || 0);

      setLoading(false);
    }
    load();
  }, []);

  async function saveProfile() {
    setSaving(prev => ({ ...prev, profile: true }));
    await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, avatarUrl }),
    });
    setSaving(prev => ({ ...prev, profile: false }));
  }

  async function addKey(provider: string) {
    const key = newKeyInputs[provider]?.trim();
    if (!key) return;
    setSaving(prev => ({ ...prev, [provider]: true }));
    await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    });
    setNewKeyInputs(prev => ({ ...prev, [provider]: '' }));
    // Refresh keys list
    const res = await fetch('/api/keys');
    setKeys(await res.json());
    setSaving(prev => ({ ...prev, [provider]: false }));
  }

  async function toggleKey(provider: string, isActive: boolean) {
    await fetch('/api/keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, isActive: !isActive }),
    });
    const res = await fetch('/api/keys');
    setKeys(await res.json());
  }

  async function deleteKey(provider: string) {
    await fetch(`/api/keys?provider=${provider}`, { method: 'DELETE' });
    const res = await fetch('/api/keys');
    setKeys(await res.json());
  }

  async function purchaseTokens(tier: string) {
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.push('/');
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-[#0d0d1a] text-[#e8e8e8]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.05]">
        <div className="flex items-center gap-4">
          <button onClick={() => router.push('/chat')} className="text-gray-400 hover:text-white transition-colors">← Back to Chat</button>
          <h1 className="text-xl font-semibold">Settings</h1>
        </div>
        <button onClick={signOut} className="text-sm text-gray-500 hover:text-red-400 transition-colors">Sign Out</button>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-10">
        {/* Profile */}
        <section>
          <h2 className="text-lg font-semibold mb-4">Profile</h2>
          <div className="space-y-3">
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Display Name"
              className="w-full px-4 py-3 rounded-xl bg-[#1a1a30] border border-gray-700 focus:border-[#6688cc] outline-none"
            />
            <input
              type="url"
              value={avatarUrl}
              onChange={e => setAvatarUrl(e.target.value)}
              placeholder="Avatar URL (optional)"
              className="w-full px-4 py-3 rounded-xl bg-[#1a1a30] border border-gray-700 focus:border-[#6688cc] outline-none"
            />
            <button
              onClick={saveProfile}
              disabled={saving.profile}
              className="px-6 py-2.5 rounded-xl bg-[#1a3a5c] hover:bg-[#22507a] font-semibold transition-colors disabled:opacity-50"
            >
              {saving.profile ? 'Saving...' : 'Save Profile'}
            </button>
          </div>
        </section>

        {/* Token Balance */}
        <section>
          <h2 className="text-lg font-semibold mb-4">Credits</h2>
          <div className="bg-[#151530] rounded-xl p-5 mb-4">
            <div className="text-3xl font-bold">{balance.toLocaleString()}</div>
            <div className="text-sm text-gray-500 mt-1">credits available</div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {TOKEN_PACKAGES.map(pkg => (
              <button
                key={pkg.tier}
                onClick={() => purchaseTokens(pkg.tier)}
                className="p-4 rounded-xl border border-gray-700 hover:border-gray-400 text-center transition-all"
              >
                <div className="font-semibold text-lg">{pkg.price}</div>
                <div className="text-sm text-gray-400">{pkg.label}</div>
                {pkg.bonus && <div className="text-xs text-green-500 mt-1">{pkg.bonus}</div>}
              </button>
            ))}
          </div>
        </section>

        {/* API Keys */}
        <section>
          <h2 className="text-lg font-semibold mb-4">Your API Keys</h2>
          <p className="text-sm text-gray-500 mb-4">
            Bring your own keys to bypass credit costs. Keys are encrypted at rest.
          </p>
          <div className="space-y-4">
            {PROVIDER_ORDER.map(provider => {
              const info = PROVIDER_LABELS[provider];
              const keyData = keys.find(k => k.provider === provider);
              const hasKey = keyData?.hasKey;

              return (
                <div key={provider} className="bg-[#151530] rounded-xl p-4 flex items-center gap-4">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: info.color }} />
                  <div className="flex-1">
                    <div className="font-medium">{info.name} <span className="text-xs text-gray-500">— {info.model}</span></div>
                    <div className="text-xs text-gray-600 mt-0.5">
                      {hasKey ? '🔑 Personal key set' : 'Using shared pool (costs credits)'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {hasKey && (
                      <>
                        <button
                          onClick={() => toggleKey(provider, keyData.isActive)}
                          className={`text-xs px-3 py-1 rounded-lg transition-colors ${keyData.isActive ? 'bg-green-900/50 text-green-400' : 'bg-gray-800 text-gray-500'}`}
                        >
                          {keyData.isActive ? 'Active' : 'Disabled'}
                        </button>
                        <button
                          onClick={() => deleteKey(provider)}
                          className="text-xs px-2 py-1 text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        >
                          Remove
                        </button>
                      </>
                    )}
                    {!hasKey && (
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={newKeyInputs[provider] || ''}
                          onChange={e => setNewKeyInputs(prev => ({ ...prev, [provider]: e.target.value }))}
                          placeholder="sk-..."
                          className="w-40 px-3 py-1.5 text-sm rounded-lg bg-[#0d0d1a] border border-gray-700 focus:border-[#6688cc] outline-none"
                        />
                        <button
                          onClick={() => addKey(provider)}
                          disabled={!newKeyInputs[provider]?.trim() || saving[provider]}
                          className="text-xs px-3 py-1.5 rounded-lg bg-[#1a3a5c] hover:bg-[#22507a] disabled:opacity-40 font-semibold transition-colors"
                        >
                          {saving[provider] ? '...' : 'Add'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
