import { NextRequest, NextResponse } from 'next/server';

const TTS_URL = process.env.TTS_SERVICE_URL || 'http://localhost:8080';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  try {
    const res = await fetch(`${TTS_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: res.status });
    }

    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.byteLength.toString(),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: `TTS service unavailable: ${err.message}` }, { status: 502 });
  }
}
