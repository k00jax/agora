import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getUserModels } from '@/lib/keys';

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const models = await getUserModels(user.id);
  return NextResponse.json({
    models: models.map(m => ({
      id: m.id,
      voiceName: m.voiceName,
      modelName: m.modelName,
      color: m.color,
      keySource: m.keySource,
    })),
  });
}
