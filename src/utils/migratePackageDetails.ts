import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { PACKAGE_DETAIL_FIELDS } from '../models/PackageDetail';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function fingerprint(name: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const record of mongoose.connection.collection(name).find().sort({ _id: 1 })) {
    if (name === 'packages') delete record.details;
    hash.update(mongoose.mongo.BSON.serialize(record));
  }
  return hash.digest('hex');
}

export async function migratePackageDetails(apply = false) {
  const connection = mongoose.connection;
  if (connection.name !== 'studio_db')
    throw new Error('Migration is restricted to the configured studio_db database');
  const packages = connection.collection('packages');
  const details = connection.collection('package_details');
  const records = await packages
    .find({ details: { $exists: true } }, { projection: { details: 1, detailsVersion: 1 } })
    .toArray();
  for (const record of records) {
    if (
      !record.details ||
      typeof record.details !== 'object' ||
      Array.isArray(record.details) ||
      Object.keys(record.details).some(
        (key) => !(PACKAGE_DETAIL_FIELDS as readonly string[]).includes(key),
      )
    )
      throw new Error('Unexpected package content; refusing to drop unknown data');
    if (!Number.isSafeInteger(record.detailsVersion ?? 0) || (record.detailsVersion ?? 0) < 0)
      throw new Error('Invalid package content revision');
  }
  console.log(
    JSON.stringify({ database: connection.name, apply, embeddedPackages: records.length }),
  );
  if (!apply || !records.length) return;
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-package-details-'));
  await writeFile(
    path.join(backupDirectory, 'packages-details.bson'),
    Buffer.concat(records.map((record) => mongoose.mongo.BSON.serialize(record))),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify({ backupDirectory }));
  const names = (await connection.db!.listCollections({}, { nameOnly: true }).toArray())
    .map((row) => row.name)
    .filter((name) => name !== 'package_details' && !name.startsWith('system.'));
  const before = await Promise.all(names.map(fingerprint));
  await details.createIndex({ package: 1 }, { unique: true });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const original of records) {
        const pkg = await packages.findOne({ _id: original._id }, { session });
        if (
          !pkg ||
          !isDeepStrictEqual(pkg.details, original.details) ||
          (pkg.detailsVersion ?? 0) !== (original.detailsVersion ?? 0)
        )
          throw new Error('Package changed after backup; migration stopped without overwriting it');
        const existing = await details.findOne({ package: pkg._id }, { session });
        if (existing) {
          const content = Object.fromEntries(
            Object.keys(pkg.details).map((key) => [key, existing[key]]),
          );
          if (
            existing.version !== (pkg.detailsVersion ?? 0) ||
            !isDeepStrictEqual(content, pkg.details)
          )
            throw new Error('PackageDetail conflicts with embedded content; migration stopped');
        } else {
          await details.insertOne(
            {
              package: pkg._id,
              version: pkg.detailsVersion ?? 0,
              ...pkg.details,
              createdAt: pkg.createdAt ?? new Date(),
              updatedAt: pkg.updatedAt ?? new Date(),
            },
            { session },
          );
        }
        await packages.updateOne({ _id: pkg._id }, { $unset: { details: '' } }, { session });
      }
    });
  } finally {
    await session.endSession();
  }
  if (await packages.countDocuments({ details: { $exists: true } }))
    throw new Error('New embedded content appeared during migration; inspect concurrent writers');
  const after = await Promise.all(names.map(fingerprint));
  if (before.some((value, index) => value !== after[index]))
    throw new Error('Other data changed during verification; inspect concurrent activity');
  for (const original of records) {
    const detail = await details.findOne({ package: original._id });
    if (
      !detail ||
      detail.version !== (original.detailsVersion ?? 0) ||
      !isDeepStrictEqual(
        Object.fromEntries(Object.keys(original.details).map((key) => [key, detail[key]])),
        original.details,
      )
    )
      throw new Error('Transferred content does not match its backup');
  }
  console.log(
    JSON.stringify({
      transferred: records.length,
      embeddedPackages: 0,
      businessDataUnchanged: true,
      backupDirectory,
    }),
  );
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('Missing MONGO_URI');
  await mongoose.connect(process.env.MONGO_URI, {
    autoCreate: false,
    autoIndex: false,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 15000,
  });
  try {
    await migratePackageDetails(process.argv.includes('--apply'));
  } finally {
    await mongoose.disconnect();
  }
}
if (require.main === module)
  main().catch((error: Error) => {
    console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi, '[REDACTED_URI]'));
    process.exitCode = 1;
  });
