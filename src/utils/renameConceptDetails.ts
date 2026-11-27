import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const source = 'conceptpackages';
const target = 'concept_details';

async function fingerprint(name: string) {
  const hash = createHash('sha256');
  for await (const row of mongoose.connection.collection(name).find().sort({ _id: 1 }))
    hash.update(mongoose.mongo.BSON.serialize(row));
  return hash.digest('hex');
}

export async function renameConceptDetails(apply = false) {
  const connection = mongoose.connection;
  if (connection.name !== 'studio_db' && !/^studio_concept_detail_test_\d+$/.test(connection.name))
    throw new Error('Rename only supports studio_db or an isolated concept detail test database');
  const names = (await connection.db!.listCollections({}, { nameOnly: true }).toArray())
    .map((row) => row.name)
    .filter((name) => !name.startsWith('system.'));
  const sourceExists = names.includes(source),
    targetExists = names.includes(target);
  const targetCount = targetExists ? await connection.collection(target).countDocuments() : 0;
  const count = sourceExists ? await connection.collection(source).countDocuments() : targetCount;
  console.log(
    JSON.stringify({
      database: connection.name,
      sourceExists,
      targetExists,
      count,
      targetCount,
      apply,
    }),
  );
  if (sourceExists && targetCount > 0)
    throw new Error(
      'Both conceptpackages and concept_details contain data; refusing to overwrite or merge',
    );
  if (!sourceExists) {
    if (!targetExists)
      throw new Error(
        'No concept detail collection found; refusing to create an empty replacement',
      );
    console.log(JSON.stringify({ alreadyRenamed: true, count }));
    return;
  }
  if (!apply) return;
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-concept-details-'));
  const before = await Promise.all(names.map(fingerprint));
  const records = await connection.collection(source).find().sort({ _id: 1 }).toArray();
  const indexes = await connection.collection(source).listIndexes().toArray();
  await writeFile(
    path.join(backupDirectory, `${source}.bson`),
    Buffer.concat(records.map((row) => mongoose.mongo.BSON.serialize(row))),
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    path.join(backupDirectory, 'manifest.json'),
    JSON.stringify(
      {
        database: connection.name,
        source,
        target,
        count,
        indexes,
        emptyTargetIndexes: targetExists
          ? await connection.collection(target).listIndexes().toArray()
          : undefined,
      },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify({ backupDirectory }));
  if ((await fingerprint(source)) !== before[names.indexOf(source)])
    throw new Error('Source changed after backup; stop API/worker and retry');
  const archivedTarget = targetExists ? `${target}_before_rename_${Date.now()}` : undefined;
  if (archivedTarget)
    await connection.collection(target).rename(archivedTarget, { dropTarget: false });
  try {
    await connection.collection(source).rename(target, { dropTarget: false });
  } catch (error) {
    if (archivedTarget)
      await connection.collection(archivedTarget).rename(target, { dropTarget: false });
    throw error;
  }
  const after = await Promise.all(
    names.map((name) =>
      fingerprint(name === source ? target : name === target ? archivedTarget! : name),
    ),
  );
  if (
    before.some((hash, index) => hash !== after[index]) ||
    !isDeepStrictEqual(indexes, await connection.collection(target).listIndexes().toArray())
  )
    throw new Error(
      'Documents or indexes changed during rename verification; inspect concurrent writers',
    );
  console.log(
    JSON.stringify({
      renamed: true,
      count,
      allDocumentsUnchanged: true,
      indexesUnchanged: true,
      verifiedCollections: names.length,
      backupDirectory,
      archivedTarget,
    }),
  );
  return { count, backupDirectory, archivedTarget };
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
    await renameConceptDetails(process.argv.includes('--apply'));
  } finally {
    await mongoose.disconnect();
  }
}
if (require.main === module)
  main().catch((error: Error) => {
    console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi, '[REDACTED_URI]'));
    process.exitCode = 1;
  });
