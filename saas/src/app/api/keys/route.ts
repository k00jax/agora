import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { userApiKeys } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptApiKey, maskKey } from '@/lib/encryption';
import { ALL_MODELS } from '@/lib/models';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const keys = await db.query.userApiKeys.findMany({
    where: eq(userApiKeys.userId, user.id),
  });

  // Return all 5 providers, showing which have keys
  const result = ALL_MODELS.map(model => {
    const key = keys.find(k => k.provider === model.provider);
    return {
      provider: model.provider,
      modelName: model.voiceName,
      modelLabel: model.modelName,
      color: model.color,
      hasKey: !!key,
      isActive: key?.isActive ?? false,
      maskedKey: key ? maskKey('placeholder') : null, // can't unmask without decrypting
      createdAt: key?.createdAt || null,
    };
  });

  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { provider, key } = body as { provider?: string; key?: string };

  if (!provider || !key) {
    return NextResponse.json({ error: 'provider and key required' }, { status: 400 });
  }

  const validProviders = ALL_MODELS.map(m => m.provider);
  if (!validProviders.includes(provider)) {
    return NextResponse.json({ error: `Invalid provider: ${provider}` }, { status: 400 });
  }

  const encrypted = encryptApiKey(key.trim());

  await db.insert(userApiKeys)
    .values({
      userId: user.id,
      provider,
      encryptedKey: encrypted,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [userApiKeys.userId, userApiKeys.provider],
      set: { encryptedKey: encrypted, isActive: true, updatedAt: new Date() },
    });

  return NextResponse.json({ ok: true, provider, masked: '****' });
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { provider, isActive } = body as { provider?: string; isActive?: boolean };

  if (!provider || isActive === undefined) {
    return NextResponse.json({ error: 'provider and isActive required' }, { status: 400 });
  }

  await db.update(userApiKeys)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(userApiKeys.userId, user.id), eq(userApiKeys.provider, provider)));

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const provider = searchParams.get('provider');
  if (!provider) return NextResponse.json({ error: 'provider required' }, { status: 400 });

  await db.delete(userApiKeys)
    .where(and(eq(userApiKeys.userId, user.id), eq(userApiKeys.provider, provider)));

  return NextResponse.json({ ok: true });
}
