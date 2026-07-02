import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { stripeCustomers, stripePurchases } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { dollarsToCredits } from '@/lib/tokens';

const PRICE_PACKAGES = {
  small: { usd: 5, credits: dollarsToCredits(5) },
  medium: { usd: 15, credits: dollarsToCredits(17) },   // $2 bonus
  large: { usd: 30, credits: dollarsToCredits(36) },    // $6 bonus
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { tier } = body as { tier?: 'small' | 'medium' | 'large' };
  const pkg = PRICE_PACKAGES[tier || 'small'];

  // Get or create Stripe customer
  let customer = await db.query.stripeCustomers.findFirst({
    where: eq(stripeCustomers.userId, user.id),
  });

  if (!customer) {
    const stripeCustomer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    await db.insert(stripeCustomers).values({
      userId: user.id,
      stripeCustomerId: stripeCustomer.id,
    });
    customer = { stripeCustomerId: stripeCustomer.id };
  }

  const session = await stripe.checkout.sessions.create({
    customer: customer.stripeCustomerId,
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${pkg.credits.toLocaleString()} Credits`,
          description: `${tier || 'small'} credit pack for AI Group Chat`,
        },
        unit_amount: pkg.usd * 100, // Stripe uses cents
      },
      quantity: 1,
    }],
    metadata: {
      userId: user.id,
      credits: pkg.credits.toString(),
      tier: tier || 'small',
    },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/chat?purchase=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/settings?purchase=cancelled`,
  });

  // Record pending purchase
  await db.insert(stripePurchases).values({
    userId: user.id,
    stripeSessionId: session.id,
    amountUsd: pkg.usd * 100,
    creditsPurchased: pkg.credits,
    status: 'pending',
  });

  return NextResponse.json({ url: session.url });
}
