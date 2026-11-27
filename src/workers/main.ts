import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DelayedError, Job, Worker } from 'bullmq';
import { randomUUID } from 'crypto';
import { queueConfig } from '../config/queue';
import { assertJobRuntime, closeQueues, getQueue, queueConnection } from '../services/jobQueue';
import { emailConfig } from '../services/email';
import EmailOutbox from '../models/EmailOutbox';
import Operation from '../models/BackgroundOperation';
import { executeAlbumOperation } from '../services/backgroundOperations';
import { processEmailJob } from './email';
import { dispatchPendingJobs } from './outboxDispatcher';
import { runMaintenance } from './maintenance';
import { assertSharedAlbumStore } from '../services/sharedAlbumStore';
import { assertConceptDetailStore } from '../services/conceptDetailStore';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export async function processAlbumJob(job: Job, token?: string) {
  if (job.data?.schemaVersion !== 1 || !/^[a-f0-9]{24}$/i.test(job.data.operationId || ''))
    throw new Error('Invalid album job payload');
  const result = await executeAlbumOperation(job.data.operationId);
  if (result === 'idle') {
    const row = await Operation.findById(job.data.operationId).lean();
    if (row && ['pending', 'running'].includes(row.status)) {
      const wake = row.status === 'running' ? row.lockedUntil : row.nextAttemptAt;
      await job.moveToDelayed(Math.max(Date.now() + 2000, Number(wake || 0)), token);
      throw new DelayedError();
    }
  }
}

async function main() {
  const config = queueConfig();
  if (config.mode !== 'bullmq') throw new Error('Worker requires BullMQ mode');
  await mongoose.connect(process.env.MONGO_URI!);
  await assertSharedAlbumStore();
  await assertConceptDetailStore();
  await assertJobRuntime();
  emailConfig();
  await Promise.all([EmailOutbox.init(), Operation.init()]);
  await getQueue('maintenance').upsertJobScheduler(
    'expiry-v1',
    { every: 60000 },
    { name: 'expiry-scan', data: { schemaVersion: 1 } },
  );
  const connection = queueConnection(true);
  const workers = [
    new Worker('email', processEmailJob, { connection, prefix: config.prefix, concurrency: 2 }),
    new Worker('album-sync', processAlbumJob, {
      connection,
      prefix: config.prefix,
      concurrency: 1,
      lockDuration: 120000,
    }),
    new Worker(
      'maintenance',
      async (job) => {
        if (job.data?.schemaVersion !== 1) throw new Error('Invalid maintenance job payload');
        await runMaintenance();
      },
      { connection, prefix: config.prefix, concurrency: 1 },
    ),
  ];
  for (const worker of workers) {
    worker.on('error', () => console.error(`[Jobs] ${worker.name} worker unavailable`));
    worker.on('failed', (job) =>
      console.error(`[Jobs] ${worker.name} failed job ${job?.id || 'unknown'}`),
    );
  }
  let running = false,
    stopping = false;
  const instance = randomUUID();
  const tick = async () => {
    if (running || stopping) return;
    running = true;
    try {
      const control = await mongoose.connection
        .collection('backgroundjobruntime')
        .findOne({ _id: 'runtime' as any });
      if (control?.stopWorkerInstance === instance) {
        void shutdown();
        return;
      }
      await assertJobRuntime();
      await mongoose.connection
        .collection('backgroundjobruntime')
        .updateOne(
          { _id: 'runtime' as any, mode: 'bullmq', prefix: config.prefix },
          { $set: { workerSeenAt: new Date(), workerPid: process.pid, workerInstance: instance } },
        );
      await dispatchPendingJobs();
    } catch {
      console.error('[Jobs] Dispatcher unavailable; durable pending work retained');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 5000);
  await tick();
  console.log('[Jobs] Worker ready:', config.prefix);
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 30000));
    await Promise.race([Promise.allSettled(workers.map((w) => w.close())), deadline]);
    connection.disconnect();
    await closeQueues();
    await mongoose.connection
      .collection('backgroundjobruntime')
      .updateOne(
        { _id: 'runtime' as any, workerInstance: instance },
        { $set: { workerStoppedAt: new Date() } },
      );
    await mongoose.disconnect();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Node IPC allows the same graceful shutdown path in Windows integration tests.
  process.on('message', (message) => {
    if (message === 'shutdown') void shutdown();
  });
}

if (require.main === module)
  main().catch(async () => {
    console.error('[Jobs] Worker startup failed; verify API mode, namespace and connections');
    await closeQueues();
    await mongoose.disconnect();
    process.exitCode = 1;
  });
