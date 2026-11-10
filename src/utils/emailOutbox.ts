import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import EmailOutbox from '../models/EmailOutbox';
import User from '../models/User';
import { enqueuePendingDepositEmails, processEmailOutbox } from '../services/email';
import { withResourceTransaction } from '../services/workflowTransactions';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
async function main() {
  const [command = 'list', id] = process.argv.slice(2);
  if (!['list', 'scan', 'retry', 'process'].includes(command))
    throw new Error('Use list | scan [username] | retry ID | process');
  await mongoose.connect(process.env.MONGO_URI!);
  try {
    await EmailOutbox.init();
    if (command === 'list') {
      console.log(
        JSON.stringify(
          await EmailOutbox.find()
            .sort({ createdAt: -1 })
            .limit(50)
            .select('kind status attempts booking lastError sentAt')
            .lean(),
          null,
          2,
        ),
      );
    } else if (command === 'scan') {
      const users = await User.find({
        roles: 6,
        isActive: true,
        emailVerifiedAt: { $exists: true },
        ...(id ? { username: id } : {}),
      }).select('_id');
      for (const user of users)
        await withResourceTransaction((session) =>
          enqueuePendingDepositEmails(String(user._id), session),
        );
      console.log(`Checked ${users.length} accounts; eligible missing notices are queued.`);
    } else if (command === 'retry') {
      if (!mongoose.isValidObjectId(id)) throw new Error('Invalid job ID');
      const job = await EmailOutbox.findOneAndUpdate(
        { _id: id, status: 'failed', firstAttemptAt: { $gt: new Date(Date.now() - 23 * 3600000) } },
        { $set: { status: 'pending', nextAttemptAt: new Date(), attempts: 0 } },
        { new: true },
      );
      if (!job)
        throw new Error(
          'Only failed jobs within the original 23-hour window may retry. Older ambiguous deliveries require provider-log review; do not reset firstAttemptAt.',
        );
      console.log(`Queued ${job._id}; provider idempotency key and payload retained.`);
    } else console.log(`Processed ${await processEmailOutbox()} jobs.`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(() => {
  console.error(
    'Email maintenance failed. Check arguments, configuration and retry-window eligibility.',
  );
  process.exitCode = 1;
});
