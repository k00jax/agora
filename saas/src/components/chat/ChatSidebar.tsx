'use client';

import { useState, useEffect } from 'react';

interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
}

interface ChatSidebarProps {
  open: boolean;
  onToggle: () => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
}

export default function ChatSidebar({ open, onToggle, onSelectChat, onNewChat }: ChatSidebarProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);

  useEffect(() => {
    fetch('/api/chats').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setChats(d);
    }).catch(() => {});
  }, []);

  async function deleteChat(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/chats/${id}`, { method: 'DELETE' });
    setChats(prev => prev.filter(c => c.id !== id));
  }

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className="fixed top-[84px] z-50 w-6 h-6 rounded-full bg-[#1a1a30] border border-white/[0.1] text-gray-500 hover:text-gray-300 flex items-center justify-center text-xs transition-colors"
        style={{ left: open ? 268 : 8 }}
      >
        {open ? '◀' : '▶'}
      </button>

      {/* Sidebar */}
      <div className={`bg-[#0a0a15] border-r border-white/[0.05] flex flex-col h-full transition-all duration-300 ${open ? 'w-[280px] min-w-[280px]' : 'w-0 min-w-0 overflow-hidden'}`}>
        <div className="p-4 border-b border-white/[0.05]">
          <button
            onClick={onNewChat}
            className="w-full py-3 rounded-lg border border-white/[0.1] hover:border-white/[0.25] text-sm font-semibold transition-colors"
          >
            + New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {chats.length === 0 && (
            <div className="text-gray-600 text-xs text-center py-4">No saved chats</div>
          )}
          {chats.map(chat => (
            <div
              key={chat.id}
              onClick={() => onSelectChat(chat.id)}
              className="group flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer hover:bg-white/[0.04] text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              <span className="truncate flex-1" title={chat.title}>{chat.title || 'Untitled'}</span>
              <button
                onClick={e => deleteChat(chat.id, e)}
                className="hidden group-hover:block text-gray-600 hover:text-red-400 px-1 rounded transition-colors ml-1"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
