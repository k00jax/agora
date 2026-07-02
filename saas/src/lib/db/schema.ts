import {
  pgTable, uuid, text, integer, boolean, timestamp,
  jsonb, uniqueIndex, check,
} from 'drizzle-orm/pg-core';

// ── Profiles (extends Supabase auth.users) ────────────────────────
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name').notNull().default('User'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ── User API Keys (encrypted at rest) ─────────────────────────────
export const userApiKeys = pgTable('user_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  provider: text('provider').notNull(), // 'openai' | 'anthropic' | 'gemini' | 'grok' | 'deepseek'
  encryptedKey: text('encrypted_key').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, t => ({
  uniqueUserProvider: uniqueIndex('user_provider_idx').on(t.userId, t.provider),
}));

// ── Token Balance ─────────────────────────────────────────────────
export const userTokens = pgTable('user_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique(),
  balance: integer('balance').notNull().default(0),
  lifetimeTokensConsumed: integer('lifetime_tokens_consumed').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ── Token Ledger (append-only audit log) ──────────────────────────
export const tokenLedger = pgTable('token_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  amount: integer('amount').notNull(), // positive = purchase, negative = consumption
  description: text('description').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ── Conversations ─────────────────────────────────────────────────
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull().default('Untitled'),
  isActive: boolean('is_active').notNull().default(false),
  indefiniteMode: boolean('indefinite_mode').notNull().default(false),
  generationCounter: integer('generation_counter').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ── Messages ──────────────────────────────────────────────────────
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull(),
  speaker: text('speaker').notNull(),
  model: text('model'), // null for user messages
  content: text('content').notNull(),
  audioBase64: text('audio_base64'), // null for user; stored or generated on-demand
  sequenceNumber: integer('sequence_number').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ── Stripe ────────────────────────────────────────────────────────
export const stripeCustomers = pgTable('stripe_customers', {
  userId: uuid('user_id').primaryKey(),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const stripePurchases = pgTable('stripe_purchases', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  stripeSessionId: text('stripe_session_id').notNull().unique(),
  amountUsd: integer('amount_usd').notNull(), // in cents
  creditsPurchased: integer('credits_purchased').notNull(),
  status: text('status').notNull().default('pending'), // pending, completed, refunded
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
