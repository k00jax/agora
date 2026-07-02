import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { profiles } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, user.id),
  });

  return NextResponse.json({
    id: user.id,
    email: user.email,
    displayName: profile?.displayName || user.user_metadata?.full_name || 'User',
    avatarUrl: profile?.avatarUrl || user.user_metadata?.avatar_url || null,
  });
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { displayName, avatarUrl } = body as { displayName?: string; avatarUrl?: string };

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (displayName !== undefined) updates.displayName = displayName;
  if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;

  await db.insert(profiles)
    .values({ id: user.id, ...updates })
    .onConflictDoUpdate({
      target: profiles.id,
      set: updates,
    });

  return NextResponse.json({ ok: true });
}
