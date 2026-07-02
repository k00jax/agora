// Simple in-memory rate limiter.
// Replace with Upstash Redis or Vercel Edge Config for production scale.

const hits = new Map<string, { count: number; resetAt: number }>();

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) {
    if (entry.resetAt < now) hits.delete(key);
  }
}, 300000).unref?.();

export function rateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || entry.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
}

export function conversationRateLimit(userId: string): boolean {
  // 30 turns per minute per user
  return rateLimit(`conv:${userId}`, 30, 60000);
}

export function authRateLimit(ip: string): boolean {
  // 10 auth attempts per minute per IP
  return rateLimit(`auth:${ip}`, 10, 60000);
}

export function stripeRateLimit(userId: string): boolean {
  // 5 checkout attempts per minute per user
  return rateLimit(`stripe:${userId}`, 5, 60000);
}
