import { db } from '@/lib/db';
import { userTokens, tokenLedger } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { createDb } from '@/lib/db';
import { ALL_MODELS, type ModelDef } from '@/lib/models';

const CREDITS_PER_DOLLAR = 1000; // $1 = 1,000 credits

export function dollarsToCredits(usd: number): number {
  return Math.round(usd * CREDITS_PER_DOLLAR);
}

export function creditsToDollars(credits: number): number {
  return credits / CREDITS_PER_DOLLAR;
}

export function estimateTurnCredits(model: ModelDef, tokenCount: number): number {
  return Math.ceil((tokenCount / 1000) * model.creditMultiplier);
}

export async function getBalance(userId: string): Promise<number> {
  const row = await db.query.userTokens.findFirst({
    where: eq(userTokens.userId, userId),
    columns: { balance: true },
  });
  return row?.balance ?? 0;
}

export async function ensureTokenRow(userId: string) {
  const existing = await db.query.userTokens.findFirst({
    where: eq(userTokens.userId, userId),
  });
  if (!existing) {
    await db.insert(userTokens).values({ userId, balance: 0 });
  }
}

export async function addCredits(userId: string, amount: number, description: string) {
  const d = createDb();
  await d.transaction(async (tx) => {
    await tx.insert(userTokens).values({ userId, balance: amount })
      .onConflictDoUpdate({
        target: userTokens.userId,
        set: { balance: sql`${userTokens.balance} + ${amount}`, updatedAt: new Date() },
      });
    await tx.insert(tokenLedger).values({
      userId, amount, description,
      createdAt: new Date(),
    });
  });
}

export async function deductCredits(
  userId: string,
  amount: number,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  const d = createDb();
  const result = await d.transaction(async (tx) => {
    const row = await tx.query.userTokens.findFirst({
      where: eq(userTokens.userId, userId),
    });
    if (!row || row.balance < amount) {
      return false;
    }
    await tx.update(userTokens)
      .set({
        balance: sql`${userTokens.balance} - ${amount}`,
        lifetimeTokensConsumed: sql`${userTokens.lifetimeTokensConsumed} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(userTokens.userId, userId));
    await tx.insert(tokenLedger).values({
      userId,
      amount: -amount,
      description,
      metadata,
      createdAt: new Date(),
    });
    return true;
  });
  return result;
}
