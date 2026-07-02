import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { conversations, messages } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { ALL_MODELS, type ModelDef } from '@/lib/models';
import { resolveApiKey } from '@/lib/keys';
import { streamModelResponse } from '@/lib/streamers';
import { sseWrite } from '@/lib/sse';
import { conversationRateLimit } from '@/lib/rate-limit';
import { estimateTurnCredits, getBalance, deductCredits, ensureTokenRow } from '@/lib/tokens';
import { createDb } from '@/lib/db';

// ── Speaker selection (weighted, same logic as Express server) ─────
function pickNextSpeaker(
  recentSpeakers: string[],
  conversationMessages: { speaker: string }[],
  triggerMessage: string,
): ModelDef {
  // Name-addressing priority
  const msg = triggerMessage.toLowerCase();
  for (const model of ALL_MODELS) {
    if (msg.includes(model.voiceName.toLowerCase()) || msg.includes(model.modelName.toLowerCase())) {
      if (model.id !== recentSpeakers[0]) return model;
    }
  }

  // Weighted random
  const turnsSince: Record<string, number> = {};
  for (const m of ALL_MODELS) turnsSince[m.id] = Infinity;
  for (let i = conversationMessages.length - 1, count = 0; i >= 0; i--) {
    const cm = conversationMessages[i];
    if (cm.speaker === 'User') continue;
    count++;
    const model = ALL_MODELS.find(m => m.voiceName === cm.speaker);
    if (model && turnsSince[model.id] === Infinity) turnsSince[model.id] = count;
  }

  const candidates = ALL_MODELS.filter(m => m.id !== recentSpeakers[0]);
  if (candidates.length === 0) return ALL_MODELS[Math.floor(Math.random() * ALL_MODELS.length)];

  const weights = candidates.map(m => Math.pow(turnsSince[m.id] || 1, 2));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
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
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });
  if (!conversationRateLimit(user.id)) return new Response('Rate limit exceeded', { status: 429 });

  const body = await req.json().catch(() => ({}));
  const { message, conversationId } = body as { message?: string; conversationId?: string };

  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Message required' }), { status: 400 });
  }

  // Ensure token row exists
  await ensureTokenRow(user.id);

  // Load or create conversation
  let convId = conversationId;
  if (convId) {
    const existing = await db.query.conversations.findFirst({
      where: and(eq(conversations.id, convId), eq(conversations.userId, user.id)),
    });
    if (!existing) convId = undefined;
  }

  if (!convId) {
    const title = message.trim().slice(0, 60) + (message.trim().length > 60 ? '...' : '');
    const [newConv] = await db.insert(conversations)
      .values({ userId: user.id, title, isActive: true, generationCounter: 1 })
      .returning();
    convId = newConv.id;
  } else {
    await db.update(conversations)
      .set({ generationCounter: db.raw('generation_counter + 1'), updatedAt: new Date() })
      .where(eq(conversations.id, convId));
  }

  // Load existing messages for context
  const existingMessages = await db.query.messages.findMany({
    where: eq(messages.conversationId, convId),
    orderBy: (messages, { asc }) => [asc(messages.sequenceNumber)],
  });

  // Pick speaker
  const recentSpeakerIds = existingMessages
    .filter(m => m.speaker !== 'User')
    .slice(-3)
    .map(m => ALL_MODELS.find(mod => mod.voiceName === m.speaker)?.id)
    .filter(Boolean) as string[];

  const model = pickNextSpeaker(recentSpeakerIds, existingMessages, message.trim());

  // Resolve API key
  const resolved = await resolveApiKey(user.id, model.provider);
  if (!resolved.key) {
    return new Response(JSON.stringify({ error: `${model.voiceName} is unavailable` }), { status: 402 });
  }

  // If using shared pool, check balance has enough for at least 1 turn
  if (resolved.source === 'shared-pool') {
    const balance = await getBalance(user.id);
    const estCredits = estimateTurnCredits(model, 400);
    if (balance < estCredits) {
      return new Response(JSON.stringify({ error: 'Insufficient credits. Purchase more to continue.' }), { status: 402 });
    }
  }

  // Build user message for the model
  const historyStr = existingMessages.map(m => `${m.speaker}: ${m.content}`).join('\n');
  const contextBlock = historyStr ? `Transcript so far:\n${historyStr}\n\n` : '';
  const lastMsg = existingMessages.length > 0 ? existingMessages[existingMessages.length - 1] : null;

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, convId),
    columns: { indefiniteMode: true },
  });
  const isIndefinite = conv?.indefiniteMode ?? false;

  // INVITE_USER and BREAK_LOOP detection
  let extra = '';
  const aiCount = existingMessages.filter(m => m.speaker !== 'User').length;
  if (!isIndefinite && aiCount >= 3 && aiCount % 5 === 0) extra = '[INVITE_USER] ';

  const aiMsgs = existingMessages.filter(m => m.speaker !== 'User');
  if (aiMsgs.length >= 5) {
    const recent = aiMsgs.slice(-5);
    let pairCount = 0;
    for (let i = 2; i < recent.length; i++) {
      if (recent[i].speaker === recent[i - 2].speaker && recent[i].speaker !== recent[i - 1].speaker) {
        pairCount++;
      }
    }
    if (pairCount >= 2) extra = extra + '[BREAK_LOOP] ';
  }

  const userMessageForModel = `${contextBlock}The last speaker was ${lastMsg?.speaker || 'nobody'}: "${lastMsg?.content || ''}"\n\n${extra}Respond as ${model.voiceName}.`;

  // Insert user message
  const userSeq = existingMessages.length;
  await db.insert(messages).values({
    conversationId: convId,
    speaker: 'User',
    content: message.trim(),
    sequenceNumber: userSeq,
  });

  // SSE stream response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const genCounter = (await db.query.conversations.findFirst({
        where: eq(conversations.id, convId),
        columns: { generationCounter: true },
      }))?.generationCounter ?? 1;

      // Send meta
      sseWrite(controller, {
        type: 'meta',
        speaker: model.voiceName,
        modelName: model.modelName,
        speakerId: model.id,
        color: model.color,
      });

      // Stream the AI response
      const fullText = await streamModelResponse(model, resolved.key!, userMessageForModel, controller, convId);

      if (!fullText) {
        sseWrite(controller, { type: 'hung', speakerId: model.id });
        controller.close();
        return;
      }

      // Check if we were interrupted
      const currentGen = (await db.query.conversations.findFirst({
        where: eq(conversations.id, convId),
        columns: { generationCounter: true },
      }))?.generationCounter ?? 0;
      if (currentGen !== genCounter) { controller.close(); return; }

      // Save AI message
      await db.insert(messages).values({
        conversationId: convId,
        speaker: model.voiceName,
        model: model.modelName,
        content: fullText,
        sequenceNumber: userSeq + 1,
      });

      // Deduct credits if using shared pool
      if (resolved.source === 'shared-pool') {
        // Token count estimation (most APIs return usage, but for now estimate)
        const estimatedTokens = fullText.split(/\s+/).length * 3; // rough: 1 word ~= 3 tokens
        const credits = estimateTurnCredits(model, estimatedTokens);
        await deductCredits(user.id, credits, `Turn with ${model.voiceName}`);
      }

      // Generate TTS (TODO: call TTS microservice)
      const audio = null; // placeholder

      sseWrite(controller, {
        type: 'done',
        audio,
        speaker: model.voiceName,
        speakerId: model.id,
        invitedUser: extra.includes('[INVITE_USER]'),
      });
      controller.close();
    },
    cancel() {
      // Client disconnected — bump generation counter so subsequent checks invalidate
      db.update(conversations)
        .set({ generationCounter: sql`generation_counter + 1` })
        .where(eq(conversations.id, convId))
        .execute()
        .catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

