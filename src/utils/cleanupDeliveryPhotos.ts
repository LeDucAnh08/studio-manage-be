import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import { cleanupDeliveryPhotos } from '../services/bookingDelivery';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
async function main() {
  await mongoose.connect(process.env.MONGO_URI!);
  try {
    console.log(`Removed ${await cleanupDeliveryPhotos()} stale private photo files.`);
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(() => {
  console.error(
    'Photo cleanup failed; existing published photos were retained. Check storage and database connectivity.',
  );
  process.exitCode = 1;
});
