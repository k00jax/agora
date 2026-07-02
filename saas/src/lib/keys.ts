import { db } from '@/lib/db';
import { userApiKeys } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { decryptApiKey } from '@/lib/encryption';
import type { KeySource, UserModel } from '@/lib/models';
import { ALL_MODELS } from '@/lib/models';

interface ResolvedKey {
  source: KeySource;
  key: string | null;
}

export async function resolveApiKey(userId: string, provider: string): Promise<ResolvedKey> {
  // 1. Check for user's personal key
  const personalKey = await db.query.userApiKeys.findFirst({
    where: and(
      eq(userApiKeys.userId, userId),
      eq(userApiKeys.provider, provider),
      eq(userApiKeys.isActive, true),
    ),
  });

  if (personalKey) {
    return {
      source: 'personal',
      key: decryptApiKey(personalKey.encryptedKey),
    };
  }

  // 2. Fall back to shared pool key
  const model = ALL_MODELS.find(m => m.provider === provider);
  if (!model) return { source: 'unavailable', key: null };

  const sharedKey = process.env[model.envKey];
  if (sharedKey) {
    return { source: 'shared-pool', key: sharedKey };
  }

  return { source: 'unavailable', key: null };
}

export async function getUserModels(userId: string): Promise<UserModel[]> {
  return Promise.all(
    ALL_MODELS.map(async (model) => {
      const resolved = await resolveApiKey(userId, model.provider);
      return { ...model, keySource: resolved.source };
    }),
  );
}
