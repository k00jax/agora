'use client';

import { useEffect, useRef } from 'react';

interface Message {
  speaker: string;
  model: string | null;
  content: string;
  color?: string;
}

interface MessageListProps {
  messages: Message[];
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .trim();
}

export default function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
      {messages.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          Say something to start the roundtable
        </div>
      )}
      {messages.map((msg, i) => {
        const isUser = msg.speaker === 'User';
        const color = msg.color || '#888';
        return (
          <div
            key={i}
            className={`
              max-w-[75%] px-4 py-3 rounded-2xl animate-[msgIn_0.25s_ease]
              ${isUser ? 'self-end bg-[#253a5e] rounded-br-sm' : 'self-start rounded-bl-sm'}
            `}
            style={!isUser ? { background: `${color}18`, borderLeft: `3px solid ${color}` } : undefined}
          >
            <div
              className="text-[11px] font-bold uppercase tracking-wide mb-1"
              style={{ color: isUser ? '#aaa' : color }}
            >
              {isUser ? 'You' : msg.speaker}{' '}
              <span className="font-normal normal-case tracking-normal text-gray-500">
                — {isUser ? 'Human' : msg.model || ''}
              </span>
            </div>
            <div className="text-sm whitespace-pre-wrap">{stripMarkdown(msg.content)}</div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
