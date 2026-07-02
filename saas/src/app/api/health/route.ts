import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const checks: Record<string, string> = {};

  // DB connectivity
  try {
    await db.query.conversations.findFirst({ columns: { id: true } });
    checks.database = 'ok';
  } catch (e: any) {
    checks.database = `error: ${e.message}`;
  }

  // Env vars
  const requiredEnv = ['NEXT_PUBLIC_SUPABASE_URL', 'DATABASE_URL', 'STRIPE_SECRET_KEY'];
  for (const key of requiredEnv) {
    checks[key] = process.env[key] ? 'set' : 'missing';
  }

  // API keys (just check presence, not validity)
  const apiKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROK_API_KEY', 'DEEPSEEK_API_KEY'];
  const availableModels = apiKeys.filter(k => process.env[k]);
  checks.api_keys = `${availableModels.length}/5 models configured`;

  const allOk = checks.database === 'ok' && !Object.values(checks).some(v => v === 'missing');

  return NextResponse.json({
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  }, { status: allOk ? 200 : 503 });
}
