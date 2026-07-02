'use client';

import { useEffect, useRef } from 'react';
import { type ModelDef } from '@/lib/models';

interface AvatarPanelProps {
  models: (ModelDef & { keySource: string })[];
  speakingId: string | null;
  bubbleText: string;
}

export default function AvatarPanel({ models, speakingId, bubbleText }: AvatarPanelProps) {
  return (
    <div className="flex justify-center gap-6 px-4 pt-5 shrink-0">
      {models.map(m => {
        const active = speakingId === m.id;
        const otherActive = speakingId && speakingId !== m.id;
        return (
          <div key={m.id} className="relative flex flex-col items-center w-[180px]">
            {/* Speech bubble */}
            <div className={`
              absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full
              bg-[#1e1e3a] border border-white/[0.08] rounded-lg px-3 py-2
              text-sm text-center min-w-[100px] max-w-[240px] z-10
              transition-opacity duration-200
              ${active && bubbleText ? 'opacity-100' : 'opacity-0 pointer-events-none'}
            `}>
              <div className="whitespace-pre-wrap break-words line-clamp-4">{bubbleText}</div>
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-[#1e1e3a]" />
            </div>

            {/* Avatar circle */}
            <div className={`
              w-32 h-32 rounded-full overflow-hidden border-4 transition-all duration-300
              ${active ? 'scale-110 brightness-125' : ''}
              ${otherActive ? 'brightness-[0.5] saturate-[0.4]' : ''}
            `}
              style={{
                borderColor: active ? m.color : 'transparent',
                boxShadow: active ? `0 0 24px ${m.color}44` : 'none',
              }}>
              <img
                src={`/api/avatar/${m.voiceName.toLowerCase()}`}
                alt={m.voiceName}
                className="w-full h-full object-cover"
                onError={e => {
                  // Fallback — in production these come from Supabase storage or static files
                  (e.target as HTMLImageElement).src = '/avatars/' + m.voiceName.toLowerCase() + '.jpg';
                }}
              />
            </div>

            {/* Labels */}
            <div className="mt-2 text-lg font-semibold" style={{ color: m.color }}>
              {m.voiceName}
            </div>
            <div className="text-xs text-gray-500">{m.modelName}</div>
            {m.keySource === 'shared-pool' && <div className="text-[10px] text-gray-600 mt-0.5">shared key</div>}
          </div>
        );
      })}
    </div>
  );
}
