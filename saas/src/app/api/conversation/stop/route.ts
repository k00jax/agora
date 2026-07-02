import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { conversations } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { conversationId } = body as { conversationId?: string };

  if (conversationId) {
    await db.update(conversations)
      .set({ isActive: false, indefiniteMode: false, updatedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));
  }

  return NextResponse.json({ ok: true });
}
