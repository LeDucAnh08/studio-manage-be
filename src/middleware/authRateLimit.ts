import { RequestHandler } from 'express';

interface RateLimitOptions {
  limit: number;
  windowMs: number;
  message: string;
}

interface Bucket {
  count: number;
  expiresAt: number;
}

// Single-process limiter for the current one-instance deployment. Phase 2 must
// replace this with a shared store before the API is scaled horizontally.
export const createRateLimit = ({ limit, windowMs, message }: RateLimitOptions): RequestHandler => {
  const buckets = new Map<string, Bucket>();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);

    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    const remaining = Math.max(0, limit - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      res.status(429).json({ success: false, message, data: null });
      return;
    }

    // Opportunistic cleanup avoids an unbounded map without keeping a timer alive.
    if (buckets.size > 2_000) {
      for (const [bucketKey, value] of buckets) {
        if (value.expiresAt <= now) buckets.delete(bucketKey);
      }
    }

    next();
  };
};

export const authRateLimit = createRateLimit({
  limit: 30,
  windowMs: 15 * 60 * 1000,
  message: 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.',
});

export const accountRequestRateLimit = createRateLimit({
  limit: 10,
  windowMs: 60 * 60 * 1000,
  message: 'Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau.',
});
