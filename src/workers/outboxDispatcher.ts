import EmailOutbox from '../models/EmailOutbox';
import Operation from '../models/BackgroundOperation';
import { emailConfig } from '../services/email';
import { assertJobRuntime, getQueue, QueueName } from '../services/jobQueue';
import { queueConfig } from '../config/queue';

async function dispatch(name: QueueName, rows: any[], idField: string, prefix: string, model: any) {
  const queue = getQueue(name);
  for (const row of rows) {
    const id = `${prefix}-${row._id}`;
    const existing = await queue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') {
        await model.updateOne(
          {
            _id: row._id,
            status: row.status,
            ...(row.lockedUntil ? { lockedUntil: row.lockedUntil } : {}),
          },
          {
            $set: {
              status: name === 'email' && row.deliveryUncertain ? 'delivery_unknown' : 'failed',
              ...(name === 'email'
                ? { lastError: 'queue_attempts_exhausted' }
                : {
                    active: false,
                    message: 'Tác vụ đã dừng sau nhiều lần lỗi. Vui lòng gửi yêu cầu mới.',
                    completedAt: new Date(),
                  }),
            },
            $unset: { leaseToken: 1, lockedUntil: 1 },
          },
        );
        continue;
      }
      if (!['completed', 'unknown'].includes(state)) continue;
      await existing.remove();
    }
    await queue.add(name, { schemaVersion: 1, [idField]: String(row._id) }, { jobId: id });
  }
}

export async function dispatchPendingJobs() {
  await assertJobRuntime();
  const config = queueConfig();
  if (config.mode !== 'bullmq') return;
  const now = new Date();
  const email = emailConfig();
  if (email) {
    const rows = await EmailOutbox.find({
      mode: email.mode,
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'sending', lockedUntil: { $lte: now } },
      ],
    })
      .sort({ nextAttemptAt: 1, _id: 1 })
      .limit(100)
      .lean();
    await dispatch('email', rows, 'outboxId', 'email', EmailOutbox);
  }
  const operations = await Operation.find({
    namespace: config.prefix,
    $or: [
      { status: 'pending', nextAttemptAt: { $lte: now } },
      { status: 'running', lockedUntil: { $lte: now } },
    ],
  })
    .sort({ nextAttemptAt: 1, _id: 1 })
    .limit(100)
    .lean();
  await dispatch('album-sync', operations, 'operationId', 'album', Operation);
}
