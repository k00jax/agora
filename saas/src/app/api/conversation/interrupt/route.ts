import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db, createDb } from '@/lib/db';
import { conversations, messages } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { ALL_MODELS } from '@/lib/models';
import { resolveApiKey } from '@/lib/keys';
import { systemPrompt } from '@/lib/prompt';

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { conversationId, currentSpeakerId } = body as { conversationId?: string; currentSpeakerId?: string };

  if (!conversationId) return NextResponse.json({ error: 'conversationId required' }, { status: 400 });

  // Bump generation counter to invalidate streaming request
  await db.update(conversations)
    .set({ generationCounter: sql`generation_counter + 1`, indefiniteMode: false })
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));

  // Pick a different model for the interrupt response
  const available = ALL_MODELS.filter(m => m.id !== currentSpeakerId);
  const model = available[Math.floor(Math.random() * available.length)];

  const resolved = await resolveApiKey(user.id, model.provider);
  if (!resolved.key) {
    return NextResponse.json({ error: `${model.voiceName} unavailable` }, { status: 402 });
  }

  // Load messages for context
  const msgs = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (messages, { asc }) => [asc(messages.sequenceNumber)],
  });

  const historyStr = msgs.map(m => `${m.speaker}: ${m.content}`).join('\n');
  const userMsg = `[USER_INTERRUPT]\n\nTranscript so far:\n${historyStr}\n\nRespond as ${model.voiceName}.`;
  const prompt = `${systemPrompt(model.voiceName, model.modelName, false)}\n\nAddress people by first name. Do not use markdown.`;

  // Sync API call (interrupt needs a quick response, can't stream)
  try {
    let response: string | null = null;
    switch (model.provider) {
      case 'openai': case 'grok': case 'deepseek': {
        const OpenAI = require('openai').OpenAI;
        const client = new OpenAI({ apiKey: resolved.key, timeout: 15000, maxRetries: 0 });
        const resp = await client.chat.completions.create({
          model: model.modelApiId,
          messages: [{ role: 'system', content: prompt }, { role: 'user', content: userMsg }],
          max_tokens: 250, temperature: 0.9,
        });
        response = resp.choices[0].message.content?.trim() ?? null;
        break;
      }
      case 'anthropic': {
        const Anthropic = require('@anthropic-ai/sdk').Anthropic;
        const client = new Anthropic({ apiKey: resolved.key });
        const resp = await client.messages.create({
          model: 'claude-sonnet-5', max_tokens: 250, temperature: 0.9,
          system: prompt, messages: [{ role: 'user', content: userMsg }],
        });
        response = resp.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
        break;
      }
      case 'gemini': {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(resolved.key);
        const genModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: prompt });
        const resp = await genModel.generateContent(userMsg);
        response = resp.response.text().trim();
        break;
      }
    }

    if (!response) return NextResponse.json({ error: 'Interrupt failed' }, { status: 500 });

    // Save interrupt message
    const seq = msgs.length;
    await db.insert(messages).values({
      conversationId,
      speaker: model.voiceName,
      model: model.modelName,
      content: response,
      sequenceNumber: seq,
    });

    return NextResponse.json({
      message: {
        speaker: model.voiceName,
        modelName: model.modelName,
        content: response,
        speakerId: model.id,
        color: model.color,
      },
      audio: null, // TODO: TTS
      halted: true,
    });
  } catch (err: any) {
    console.error('Interrupt error:', err.message);
    return NextResponse.json({ error: 'Interrupt failed' }, { status: 500 });
  }
}
