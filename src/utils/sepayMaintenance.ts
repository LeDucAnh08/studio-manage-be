import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  backfillDepositPayments,
  backfillRentalDepositPayments,
} from '../services/sepayMaintenance';
import { ingestSePayPayload, processSePayReceipt } from '../services/sepay';
import { sepayConfig } from '../services/depositPayment';
import SePayReceipt from '../models/SePayReceipt';
import BookingWorkflow from '../models/BookingWorkflow';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const option = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
async function main() {
  const command = process.argv[2];
  if (!['backfill', 'backfill-rentals', 'replay', 'import'].includes(command))
    throw new Error(
      'Usage: sepayMaintenance.ts backfill|backfill-rentals [--username mango] [--apply] | replay [--apply] | import --file webhook-payloads.json [--apply]',
    );
  await mongoose.connect(process.env.MONGO_URI!, { autoIndex: false });
  try {
    sepayConfig();
    const apply = process.argv.includes('--apply');
    if (apply) {
      await SePayReceipt.createIndexes();
      await BookingWorkflow.createIndexes();
    }
    if (command === 'backfill' || command === 'backfill-rentals')
      console.log(
        JSON.stringify(
          await (
            command === 'backfill-rentals' ? backfillRentalDepositPayments : backfillDepositPayments
          )({ username: option('--username'), apply }),
          null,
          2,
        ),
      );
    else if (command === 'replay') {
      const rows = await SePayReceipt.find({ status: 'pending', mode: process.env.SEPAY_MODE })
        .select('_id')
        .lean();
      for (const row of rows) if (apply) await processSePayReceipt(row._id);
      console.log(JSON.stringify({ command, apply, receipts: rows.length }));
    } else {
      const file = option('--file');
      if (!file) throw new Error('--file is required');
      const rows: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(rows))
        throw new Error('Expected an array of original SePay webhook payloads');
      for (const row of rows) if (apply) await ingestSePayPayload(row);
      console.log(JSON.stringify({ command, apply, receipts: rows.length }));
    }
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error) => {
  console.error(
    error.name?.startsWith('Mongo') ? 'SePay maintenance database error' : error.message,
  );
  process.exitCode = 1;
});
