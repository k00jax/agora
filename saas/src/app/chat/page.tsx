'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { UserModel } from '@/lib/models';
import AvatarPanel from '@/components/chat/AvatarPanel';
import MessageList from '@/components/chat/MessageList';
import ChatSidebar from '@/components/chat/ChatSidebar';
import NavHeader from '@/components/chat/NavHeader';

interface Message {
  speaker: string;
  model: string | null;
  content: string;
  color?: string;
}

export default function ChatPage() {
  const router = useRouter();
  const supabase = createClient();
  const [user, setUser] = useState<any>(null);
  const [models, setModels] = useState<UserModel[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [bubbleText, setBubbleText] = useState('');
  const [inputText, setInputText] = useState('');
  const [conversationActive, setConversationActive] = useState(false);
  const [haltedForUser, setHaltedForUser] = useState(false);
  const [indefiniteMode, setIndefiniteMode] = useState(false);
  const [recording, setRecording] = useState(false);
  const [statusText, setStatusText] = useState('Say something to start the roundtable');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const autoContinueRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auth check
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.push('/login');
      else setUser(data.user);
    });
  }, []);

  // Load models
  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(d => {
      if (d.models) setModels(d.models);
    });
  }, []);

  function getModelColor(modelId: string): string {
    return models.find(m => m.id === modelId)?.color || '#888';
  }

  function getModelVoiceName(modelId: string): string {
    return models.find(m => m.id === modelId)?.voiceName || '';
  }

  function getModelModelName(modelId: string): string {
    return models.find(m => m.id === modelId)?.modelName || '';
  }

  // ── SSE Consumer ─────────────────────────────────────────────────
  function cancelStream() {
    if (readerRef.current) {
      readerRef.current.cancel().catch(() => {});
      readerRef.current = null;
    }
    if (autoContinueRef.current) {
      clearTimeout(autoContinueRef.current);
      autoContinueRef.current = null;
    }
  }

  async function consumeSSE(
    response: Response,
    onMeta: (d: any) => void,
    onToken: (t: string) => void,
    onDone: (d: any) => void,
    onHung: (d: any) => void,
    onError: (msg: string) => void,
  ) {
    const reader = response.body?.getReader();
    if (!reader) return;
    readerRef.current = reader;
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            switch (data.type) {
              case 'meta': onMeta(data); break;
              case 'token': onToken(data.token); break;
              case 'done': onDone(data); break;
              case 'hung': onHung(data); break;
              case 'error': onError(data.message); break;
            }
          } catch (e) {}
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error('SSE error:', err);
    } finally {
      if (readerRef.current === reader) readerRef.current = null;
    }
  }

  // ── Audio ────────────────────────────────────────────────────────
  function playAudio(base64: string | null): boolean {
    if (!base64 || base64.length < 100) return false;
    try {
      const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const blob = new Blob([binary], { type: 'audio/mpeg' });
      if (blob.size < 200) return false;
      const url = URL.createObjectURL(blob);
      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      audioRef.current.play().catch(() => {});
      return true;
    } catch { return false; }
  }

  // ── Send Message ─────────────────────────────────────────────────
  async function sendMessage(text: string) {
    cancelStream();
    setMessages(prev => [...prev, { speaker: 'User', model: null, content: text }]);
    setConversationActive(true);
    setHaltedForUser(false);
    setIndefiniteMode(false);
    setInputText('');
    setStatusText('');

    const res = await fetch('/api/conversation/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatusText(err.error || 'Error');
      return;
    }

    if (!conversationId) {
      // Extract conversation ID from SSE or just create
      setConversationId(crypto.randomUUID());
    }

    await handleStreamResponse(res);
  }

  async function requestNextTurn() {
    if (!conversationActive || haltedForUser) return;
    cancelStream();
    setStatusText('');

    const res = await fetch('/api/conversation/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      const data = await res.json();
      if (data.halted) return;
      return;
    }
    await handleStreamResponse(res);
  }

  async function handleStreamResponse(res: Response) {
    let fullText = '';
    let metaData: any = null;

    await consumeSSE(res,
      (meta) => {
        metaData = meta;
        setSpeakingId(meta.speakerId);
        setBubbleText('');
        setStatusText(`${meta.speaker} is speaking...`);
      },
      (token) => {
        fullText += token;
        setBubbleText(fullText);
      },
      (done) => {
        if (metaData) {
          setMessages(prev => [...prev, {
            speaker: done.speaker,
            model: metaData.modelName,
            content: fullText,
            color: metaData.color,
          }]);
        }
        setBubbleText('');
        setSpeakingId(null);
        setStatusText('');
        playAudio(done.audio);

        if (done.audio && done.audio.length > 100) {
          const advance = () => {
            setSpeakingId(null);
            if (done.invitedUser && !indefiniteMode) {
              setHaltedForUser(true);
            } else {
              autoContinueRef.current = setTimeout(() => {
                if (conversationActive && !haltedForUser) requestNextTurn();
              }, 600);
            }
          };
          if (audioRef.current) {
            audioRef.current.onended = advance;
            audioRef.current.onerror = advance;
            setTimeout(() => { advance(); }, 30000); // safety
          } else {
            setTimeout(advance, 1500);
          }
        } else {
          setTimeout(() => {
            setSpeakingId(null);
            if (done.invitedUser && !indefiniteMode) {
              setHaltedForUser(true);
            } else {
              autoContinueRef.current = setTimeout(() => {
                if (conversationActive && !haltedForUser) requestNextTurn();
              }, 600);
            }
          }, 1500);
        }
      },
      (hung) => {
        setSpeakingId(null);
        setBubbleText('');
        setStatusText('Speaker timed out — picking someone else...');
        autoContinueRef.current = setTimeout(() => requestNextTurn(), 800);
      },
      (msg) => {
        setStatusText(msg);
        setSpeakingId(null);
        setBubbleText('');
      },
    );
  }

  // ── Interrupt ────────────────────────────────────────────────────
  async function interrupt() {
    if (!speakingId || !conversationId) return;
    cancelStream();
    setSpeakingId(null);
    const res = await fetch('/api/conversation/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, currentSpeakerId: speakingId }),
    });
    const data = await res.json();
    if (data.message) {
      setMessages(prev => [...prev, {
        speaker: data.message.speaker,
        model: data.message.modelName,
        content: data.message.content,
        color: data.message.color,
      }]);
      playAudio(data.audio);
    }
    setHaltedForUser(true);
    setStatusText('Your turn — say something');
  }

  // ── Stop ─────────────────────────────────────────────────────────
  async function stop() {
    cancelStream();
    setConversationActive(false);
    setHaltedForUser(false);
    setIndefiniteMode(false);
    setSpeakingId(null);
    if (conversationId) {
      await fetch('/api/conversation/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId }),
      });
    }
    setStatusText('Stopped');
  }

  // ── Voice Recording ──────────────────────────────────────────────
  async function startRecording() {
    if (typeof window === 'undefined') return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { setStatusText('Speech not available — type below'); return; }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;
    let finalText = '';

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript + ' ';
        else interim += event.results[i][0].transcript;
      }
      setStatusText(interim || finalText || 'Listening...');
    };
    recognition.onerror = () => { setRecording(false); setStatusText('Speech error'); };
    recognition.onend = () => {
      setRecording(false);
      const text = finalText.trim();
      if (text) sendMessage(text);
    };

    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      recognition.start();
      setRecording(true);
      setTimeout(() => { if (recognitionRef.current) { recognitionRef.current.stop(); setRecording(false); } }, 10000);
    } catch {
      setStatusText('Microphone access denied');
    }
  }

  function stopRecording() {
    if (recognitionRef.current) { recognitionRef.current.stop(); setRecording(false); }
  }

  // ── Indefinite Mode ──────────────────────────────────────────────
  async function enableIndefinite() {
    if (!conversationId) return;
    await fetch('/api/conversation/indefinite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    setIndefiniteMode(true);
    setHaltedForUser(false);
    requestNextTurn();
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <ChatSidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onSelectChat={async (id) => {
          const res = await fetch(`/api/chats/${id}`);
          const data = await res.json();
          setMessages(data.messages.map((m: any) => ({
            speaker: m.speaker,
            model: m.model,
            content: m.content,
            color: models.find(mod => mod.voiceName === m.speaker)?.color,
          })));
          setConversationId(id);
          setConversationActive(true);
          setStatusText('Loaded — say something to continue');
        }}
        onNewChat={() => {
          cancelStream();
          setMessages([]);
          setConversationId(null);
          setConversationActive(false);
          setHaltedForUser(false);
          setIndefiniteMode(false);
          setSpeakingId(null);
          setStatusText('New conversation — say something to start');
        }}
      />

      {/* Main Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <NavHeader sidebarOpen={sidebarOpen} />
        {/* Avatar Panel */}
        <AvatarPanel
          models={models}
          speakingId={speakingId}
          bubbleText={bubbleText}
        />

        {/* Messages */}
        <MessageList messages={messages} />

        {/* Status / Indefinite Banner */}
        {indefiniteMode && (
          <div className="px-5 py-1.5 bg-red-950/50 border-t border-red-500/20 text-center text-xs text-red-400">
            Continue Indefinitely active — models are talking amongst themselves. Press Interrupt to jump back in.
          </div>
        )}
        <div className="text-center text-xs text-gray-600 py-1">{statusText}</div>

        {/* Invite Bar */}
        {haltedForUser && (
          <div className="px-5 py-2.5 bg-green-950/30 border-t border-green-500/20 flex items-center justify-center gap-3">
            <span className="text-sm text-green-300">You&apos;re being invited in:</span>
            <button onClick={() => { setHaltedForUser(false); setStatusText('Your turn — say something'); }}
              className="px-4 py-2 bg-green-800 hover:bg-green-700 rounded-lg text-sm font-semibold transition-colors">Respond</button>
            <button onClick={() => { setHaltedForUser(false); requestNextTurn(); }}
              className="px-4 py-2 border border-gray-600 hover:border-gray-400 rounded-lg text-sm transition-colors">Continue</button>
            <button onClick={enableIndefinite}
              className="px-4 py-2 border border-red-800 hover:border-red-600 text-red-400 rounded-lg text-sm transition-colors">Continue Indefinitely</button>
          </div>
        )}

        {/* Input + Controls */}
        <div className="px-5 py-1.5 bg-[#151530] flex gap-2">
          <input
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && inputText.trim()) sendMessage(inputText.trim()); }}
            placeholder="Type your message and press Enter..."
            className="flex-1 px-4 py-2.5 rounded-lg bg-[#1a1a30] border border-gray-700 focus:border-[#6688cc] outline-none text-sm"
          />
        </div>
        <div className="px-5 pb-4 bg-[#151530] border-t border-white/[0.05] flex gap-2">
          <button
            onPointerDown={e => { e.preventDefault(); startRecording(); }}
            onPointerUp={stopRecording}
            onPointerLeave={stopRecording}
            className={`flex-1 py-3.5 rounded-xl font-semibold transition-all ${recording ? 'bg-red-600 animate-pulse' : 'bg-[#1a3a5c] hover:bg-[#22507a]'}`}
          >
            {recording ? 'Listening... Release to Send' : 'Press and Hold to Speak'}
          </button>
          <button
            onClick={interrupt}
            disabled={!speakingId}
            className="px-5 py-3.5 rounded-xl border border-red-700 text-red-400 hover:bg-red-500/10 disabled:opacity-25 disabled:cursor-not-allowed font-medium transition-colors"
          >
            Interrupt
          </button>
          <button
            onClick={stop}
            disabled={!conversationActive}
            className="px-5 py-3.5 rounded-xl border border-white/[0.08] hover:bg-white/5 disabled:opacity-25 disabled:cursor-not-allowed font-medium transition-colors"
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
