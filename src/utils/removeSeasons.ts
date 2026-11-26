import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const collections = ['customers', 'classes', 'schedules', 'transactions'];

export const seasonSnapshotFilter = (record: mongoose.mongo.Document) => ({
  _id: record._id,
  season: { $exists: true, $eq: record.season },
});

async function fingerprint(name: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const record of mongoose.connection.collection(name).find().sort({ _id: 1 })) {
    if (collections.includes(name)) delete record.season;
    hash.update(mongoose.mongo.BSON.serialize(record));
  }
  return hash.digest('hex');
}

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
    const db = mongoose.connection;
    const names = (await db.db!.listCollections({}, { nameOnly: true }).toArray()).map(
      (row) => row.name,
    );
    const seasons = names.includes('seasons')
      ? await db.collection('seasons').find().toArray()
      : [];
    const snapshots = await Promise.all(
      collections.map(async (name) => ({
        name,
        records: await db
          .collection(name)
          .find({ season: { $exists: true } }, { projection: { season: 1 } })
          .toArray(),
        indexes: names.includes(name)
          ? (await db.collection(name).indexes()).filter((index) => 'season' in index.key)
          : [],
      })),
    );
    const apply = process.argv.includes('--apply');
    console.log(
      JSON.stringify({
        database: db.name,
        apply,
        seasons: seasons.length,
        affected: snapshots.map(({ name, records, indexes }) => ({
          name,
          records: records.length,
          indexes: indexes.map((index) => index.name),
        })),
      }),
    );
    if (
      !apply ||
      (!names.includes('seasons') &&
        snapshots.every((row) => !row.records.length && !row.indexes.length))
    )
      return;

    // Back up only retired metadata; never export account details or business documents.
    const backupDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-remove-seasons-'));
    const save = (file: string, records: mongoose.mongo.Document[]) =>
      writeFile(
        path.join(backupDirectory, file),
        Buffer.concat(records.map((row) => mongoose.mongo.BSON.serialize(row))),
        { flag: 'wx', mode: 0o600 },
      );
    await save('seasons.bson', seasons);
    for (const snapshot of snapshots) {
      await save(`${snapshot.name}-season.bson`, snapshot.records);
      await save(`${snapshot.name}-indexes.bson`, snapshot.indexes);
    }
    console.log(JSON.stringify({ backupDirectory }));
    const preserved = names.filter((name) => name !== 'seasons' && !name.startsWith('system.'));
    const before = await Promise.all(preserved.map(fingerprint));
    for (const { name, records } of snapshots) {
      if (records.length)
        await db.collection(name).bulkWrite(
          records.map((record) => ({
            updateOne: {
              filter: seasonSnapshotFilter(record),
              update: { $unset: { season: '' } },
            },
          })),
        );
      if (await db.collection(name).countDocuments({ season: { $exists: true } }))
        throw new Error(
          'Season metadata changed concurrently; saved backup retained, cleanup stopped',
        );
    }
    const after = await Promise.all(preserved.map(fingerprint));
    if (before.some((value, index) => value !== after[index]))
      throw new Error(
        'Business data changed during verification; inspect backup before continuing',
      );
    // Delete only backed-up definitions which still match, retaining concurrent additions/edits.
    if (names.includes('seasons')) {
      for (const record of seasons)
        await db.collection('seasons').deleteOne({
          $and: [
            record,
            {
              $expr: {
                $eq: [{ $size: { $objectToArray: '$$ROOT' } }, Object.keys(record).length],
              },
            },
          ],
        });
      if (await db.collection('seasons').countDocuments({}))
        throw new Error('Season definitions changed concurrently; cleanup stopped');
      await db.collection('seasons').drop();
    }
    for (const { name, indexes } of snapshots)
      for (const index of indexes) await db.collection(name).dropIndex(index.name!);
    console.log(
      JSON.stringify({
        removedSeasonCollection: names.includes('seasons'),
        businessDataUnchanged: true,
        verifiedCollections: preserved.length,
        backupDirectory,
      }),
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module)
  main().catch((error: Error) => {
    console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi, '[REDACTED_URI]'));
    process.exitCode = 1;
  });
