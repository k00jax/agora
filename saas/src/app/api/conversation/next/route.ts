import { NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { conversations, messages } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { ALL_MODELS } from '@/lib/models';
import { resolveApiKey } from '@/lib/keys';
import { streamModelResponse } from '@/lib/streamers';
import { sseWrite } from '@/lib/sse';
import { estimateTurnCredits, getBalance, deductCredits } from '@/lib/tokens';

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

  const body = await req.json().catch(() => ({}));
  const { conversationId } = body as { conversationId?: string };

  if (!conversationId) return new Response(JSON.stringify({ error: 'conversationId required' }), { status: 400 });

  const conv = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)),
  });
  if (!conv) return new Response(JSON.stringify({ error: 'Conversation not found' }), { status: 404 });

  // If halted and not indefinite, bail
  if (!conv.isActive || (!conv.indefiniteMode && conv.generationCounter === -1)) {
    return new Response(JSON.stringify({ halted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Bump generation counter
  const newGen = conv.generationCounter + 1;
  await db.update(conversations)
    .set({ generationCounter: newGen })
    .where(eq(conversations.id, conversationId));

  // Load messages
  const existingMessages = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (messages, { asc }) => [asc(messages.sequenceNumber)],
  });

  // Pick next speaker (weighted random)
  const recentSpeakerIds = existingMessages
    .filter(m => m.speaker !== 'User')
    .slice(-3)
    .map(m => ALL_MODELS.find(mod => mod.voiceName === m.speaker)?.id)
    .filter(Boolean) as string[];

  const lastMsg = existingMessages[existingMessages.length - 1];
  const triggerMsg = lastMsg?.content || '';

  // Name-aware selection
  let model;
  if (triggerMsg) {
    const msg = triggerMsg.toLowerCase();
    for (const m of ALL_MODELS) {
      if ((msg.includes(m.voiceName.toLowerCase()) || msg.includes(m.modelName.toLowerCase())) && m.id !== recentSpeakerIds[0]) {
        model = m;
        break;
      }
    }
  }
  if (!model) {
    // Weighted random
    const turnsSince: Record<string, number> = {};
    for (const m of ALL_MODELS) turnsSince[m.id] = Infinity;
    for (let i = existingMessages.length - 1, count = 0; i >= 0; i--) {
      const cm = existingMessages[i];
      if (cm.speaker === 'User') continue;
      count++;
      const found = ALL_MODELS.find(mod => mod.voiceName === cm.speaker);
      if (found && turnsSince[found.id] === Infinity) turnsSince[found.id] = count;
    }
    const candidates = ALL_MODELS.filter(m => m.id !== recentSpeakerIds[0]);
    const weights = candidates.map(m => Math.pow(turnsSince[m.id] || 1, 2));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { model = candidates[i]; break; }
    }
    if (!model) model = candidates[candidates.length - 1];
  }

  // Resolve API key
  const resolved = await resolveApiKey(user.id, model.provider);
  if (!resolved.key) {
    return new Response(JSON.stringify({ error: `${model.voiceName} unavailable` }), { status: 402 });
  }

  if (resolved.source === 'shared-pool') {
    const balance = await getBalance(user.id);
    if (balance < estimateTurnCredits(model, 400)) {
      return new Response(JSON.stringify({ error: 'Insufficient credits' }), { status: 402 });
    }
  }

  // Build user message for the model
  const historyStr = existingMessages.map(m => `${m.speaker}: ${m.content}`).join('\n');
  const contextBlock = historyStr ? `Transcript so far:\n${historyStr}\n\n` : '';

  let extra = '';
  const aiCount = existingMessages.filter(m => m.speaker !== 'User').length;
  if (!conv.indefiniteMode && aiCount >= 3 && aiCount % 5 === 0) extra = '[INVITE_USER] ';

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

  const userMsg = `${contextBlock}The last speaker was ${lastMsg?.speaker || 'nobody'}: "${triggerMsg}"\n\n${extra}Respond as ${model.voiceName}.`;

  // SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      sseWrite(controller, { type: 'meta', speaker: model.voiceName, modelName: model.modelName, speakerId: model.id, color: model.color });

      const fullText = await streamModelResponse(model, resolved.key!, userMsg, controller, conversationId);
      if (!fullText) { sseWrite(controller, { type: 'hung', speakerId: model.id }); controller.close(); return; }

      // Check generation
      const currentGen = (await db.query.conversations.findFirst({
        where: eq(conversations.id, conversationId),
        columns: { generationCounter: true },
      }))?.generationCounter ?? 0;
      if (currentGen !== newGen) { controller.close(); return; }

      // Save message
      const seq = existingMessages.length;
      await db.insert(messages).values({
        conversationId, speaker: model.voiceName, model: model.modelName,
        content: fullText, sequenceNumber: seq,
      });

      if (resolved.source === 'shared-pool') {
        const estimatedTokens = fullText.split(/\s+/).length * 3;
        await deductCredits(user.id, estimateTurnCredits(model, estimatedTokens), `Turn with ${model.voiceName}`);
      }

      sseWrite(controller, {
        type: 'done', audio: null,
        speaker: model.voiceName, speakerId: model.id,
        invitedUser: extra.includes('[INVITE_USER]'),
      });
      controller.close();
    },
    cancel() {
      db.update(conversations)
        .set({ generationCounter: sql`generation_counter + 1` })
        .where(eq(conversations.id, conversationId))
        .execute().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    },
  });
}
