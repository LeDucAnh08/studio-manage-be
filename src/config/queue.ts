import { createHash } from 'crypto';
import ConnectionString from 'mongodb-connection-string-url';

export function queueConfig() {
  const mode = process.env.BACKGROUND_JOBS_MODE || 'legacy';
  if (!['legacy', 'bullmq'].includes(mode)) throw new Error('Invalid BACKGROUND_JOBS_MODE');
  if (mode === 'legacy') return { mode: 'legacy' as const };
  let mongo: ConnectionString, redis: URL;
  try {
    mongo = new ConnectionString(process.env.MONGO_URI || '');
    redis = new URL(process.env.REDIS_URL || '');
  } catch {
    throw new Error('Background jobs require valid MongoDB and Redis configuration');
  }
  const name = decodeURIComponent(mongo.pathname.slice(1));
  const prefix = process.env.BACKGROUND_JOBS_PREFIX || 'yume';
  if (
    !/^[a-zA-Z0-9_-]{1,50}$/.test(prefix) ||
    !name ||
    !['redis:', 'rediss:'].includes(redis.protocol) ||
    redis.search ||
    redis.hash ||
    (redis.pathname && !/^\/\d{1,2}$/.test(redis.pathname))
  )
    throw new Error('Invalid queue namespace or Redis configuration');
  if (
    process.env.NODE_ENV !== 'production' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname)
  )
    throw new Error('Development Redis must use loopback');
  const scope = createHash('sha256')
    .update(
      `${mongo.hosts.join(',')}/${name}/${process.env.NODE_ENV || 'development'}/${process.env.EMAIL_MODE || 'disabled'}`,
    )
    .digest('hex')
    .slice(0, 16);
  return { mode: 'bullmq' as const, prefix: `${prefix}-${scope}`, url: redis.toString() };
}

export const backgroundJobsEnabled = () => queueConfig().mode === 'bullmq';
