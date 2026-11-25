import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const fields = ['telegramId', 'telegramUsername', 'telegramLinkToken', 'telegramLinkTokenExpiry'];

export const snapshotFilter = (
  record: mongoose.mongo.Document,
): mongoose.mongo.Filter<mongoose.mongo.Document> => ({
  _id: record._id,
  $and: fields.map((field) =>
    Object.prototype.hasOwnProperty.call(record, field)
      ? { [field]: { $exists: true, $eq: record[field] } }
      : { [field]: { $exists: false } },
  ),
});

async function main(): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error('Missing MONGO_URI');
  await mongoose.connect(process.env.MONGO_URI, {
    autoCreate: false,
    autoIndex: false,
    serverSelectionTimeoutMS: 10000,
  });
  try {
    if (mongoose.connection.name !== 'studio_db')
      throw new Error('Cleanup is restricted to the configured studio_db database');
    const users = mongoose.connection.collection('users');
    const filter = { $or: fields.map((field) => ({ [field]: { $exists: true } })) };
    const projection = Object.fromEntries(fields.map((field) => [field, 1]));
    const records = await users.find(filter, { projection }).toArray();
    const totalUsers = await users.countDocuments({});
    const apply = process.argv.includes('--apply');
    console.log(
      JSON.stringify({
        database: mongoose.connection.name,
        totalUsers,
        affected: records.length,
        apply,
      }),
    );
    if (!apply || !records.length) return;

    const backupDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-telegram-cleanup-'));
    const backupPath = path.join(backupDirectory, 'users-telegram.bson');
    await writeFile(
      backupPath,
      Buffer.concat(records.map((record) => mongoose.mongo.BSON.serialize(record))),
      { flag: 'wx', mode: 0o600 },
    );
    // Use the raw collection so removing obsolete fields does not change account timestamps.
    // Match the saved values, including missing versus null, so concurrent edits are retained.
    console.log(JSON.stringify({ backupPath }));
    const result = await users.bulkWrite(
      records.map((record) => ({
        updateOne: {
          filter: snapshotFilter(record),
          update: { $unset: Object.fromEntries(fields.map((field) => [field, ''])) },
        },
      })),
    );
    const remaining = await users.countDocuments(filter);
    if (remaining || (await users.countDocuments({})) !== totalUsers)
      throw new Error('Cleanup verification failed; inspect the saved backup');
    console.log(JSON.stringify({ modified: result.modifiedCount, remaining, backupPath }));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi, '[REDACTED_URI]'));
    process.exitCode = 1;
  });
}
