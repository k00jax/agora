import { NextRequest, NextResponse } from 'next/server';
import { db, createDb } from '@/lib/db';
import { stripePurchases } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { addCredits } from '@/lib/tokens';
import Stripe from 'stripe';
import { headers } from 'next/headers';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = (await headers()).get('stripe-signature');

  if (!sig) return NextResponse.json({ error: 'No signature' }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    return NextResponse.json({ error: `Signature verification failed: ${err.message}` }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    const credits = parseInt(session.metadata?.credits || '0', 10);

    if (userId && credits > 0) {
      // Mark purchase as completed
      await db.update(stripePurchases)
        .set({ status: 'completed' })
        .where(eq(stripePurchases.stripeSessionId, session.id));

      // Credit the user
      await addCredits(userId, credits, `Purchased ${credits.toLocaleString()} credits`);
    }
  }

  if (event.type === 'checkout.session.expired') {
    const session = event.data.object as Stripe.Checkout.Session;
    await db.update(stripePurchases)
      .set({ status: 'refunded' })
      .where(eq(stripePurchases.stripeSessionId, session.id));
  }

  return NextResponse.json({ received: true });
}
