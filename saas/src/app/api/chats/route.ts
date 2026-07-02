import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { conversations, messages } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
// import { saveConversation as saveFn, loadConversation as loadFn } are inline

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const chats = await db.query.conversations.findMany({
    where: eq(conversations.userId, user.id),
    columns: { id: true, title: true, createdAt: true },
    orderBy: [desc(conversations.updatedAt)],
  });

  return NextResponse.json(chats);
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Save the active conversation — called by frontend on stop/new-chat
  // The conversation should already exist in the DB
  const body = await req.json().catch(() => ({}));
  const { conversationId } = body as { conversationId?: string };

  if (conversationId) {
    await db.update(conversations)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));
  }

  return NextResponse.json({ ok: true });
}
