import { Queue } from 'bullmq';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { queueConfig } from '../config/queue';

export const jobNames = ['email', 'maintenance', 'album-sync'] as const;
export type QueueName = (typeof jobNames)[number];
let connection: Redis | undefined;
const queues = new Map<QueueName, Queue>();

export function queueConnection(worker = false) {
  const config = queueConfig();
  if (config.mode !== 'bullmq') throw new Error('BullMQ mode is not enabled');
  const client = new Redis(config.url, {
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    connectTimeout: 2000,
    commandTimeout: worker ? undefined : 3000,
    retryStrategy: (n) => Math.min(250 * n, 3000),
  });
  client.on('error', () => console.error('[Jobs] Redis connection unavailable'));
  return client;
}

export function getQueue(name: QueueName) {
  const config = queueConfig();
  if (config.mode !== 'bullmq') throw new Error('BullMQ mode is not enabled');
  if (!queues.has(name)) {
    connection ||= queueConnection();
    const queue = new Queue(name, {
      connection,
      prefix: config.prefix,
      defaultJobOptions: {
        attempts: name === 'email' ? 10 : 5,
        backoff: { type: 'exponential', delay: name === 'email' ? 30000 : 10000 },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 7 * 86400, count: 2000 },
      },
    });
    queue.on('error', () => console.error(`[Jobs] ${name} queue unavailable`));
    queues.set(name, queue);
  }
  return queues.get(name)!;
}

export async function initializeJobRuntime() {
  const config = queueConfig();
  await mongoose.connection.collection('backgroundjobruntime').updateOne(
    { _id: 'runtime' as any },
    {
      $set: {
        mode: config.mode,
        prefix: config.mode === 'bullmq' ? config.prefix : '',
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function assertJobRuntime() {
  const config = queueConfig();
  const runtime = await mongoose.connection
    .collection('backgroundjobruntime')
    .findOne({ _id: 'runtime' as any });
  if (config.mode !== 'bullmq' || runtime?.mode !== 'bullmq' || runtime.prefix !== config.prefix)
    throw new Error('Background worker mode or namespace does not match API');
}

export async function closeQueues() {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
  connection?.disconnect();
  connection = undefined;
}
