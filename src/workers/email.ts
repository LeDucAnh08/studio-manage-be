import { DelayedError, Job } from 'bullmq';
import EmailOutbox from '../models/EmailOutbox';
import { processOneEmailOutbox } from '../services/email';
import { assertJobRuntime } from '../services/jobQueue';

export async function processEmailJob(job: Job, token?: string) {
  if (job.data?.schemaVersion !== 1 || !/^[a-f0-9]{24}$/i.test(job.data.outboxId || ''))
    throw new Error('Invalid email job payload');
  await assertJobRuntime();
  const result = await processOneEmailOutbox(job.data.outboxId, undefined, assertJobRuntime);
  if (result === 'retry') throw new Error('Email delivery will retry');
  if (result === 'idle') {
    const row = await EmailOutbox.findById(job.data.outboxId).lean();
    if (row && ['pending', 'sending'].includes(row.status)) {
      const wake = row.status === 'sending' ? row.lockedUntil : row.nextAttemptAt;
      await job.moveToDelayed(Math.max(Date.now() + 2000, Number(wake || 0)), token);
      throw new DelayedError();
    }
  }
}
