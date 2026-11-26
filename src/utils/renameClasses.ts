import { createHash } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function fingerprint(name: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const record of mongoose.connection.collection(name).find().sort({ _id: 1 }))
    hash.update(mongoose.mongo.BSON.serialize(record));
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
    const connection = mongoose.connection;
    if (connection.name !== 'studio_db')
      throw new Error('Rename is restricted to the configured studio_db database');
    const names = (await connection.db!.listCollections({}, { nameOnly: true }).toArray())
      .map((row) => row.name)
      .filter((name) => !name.startsWith('system.'));
    const sourceExists = names.includes('customers');
    const targetExists = names.includes('classes');
    const targetCount = targetExists
      ? await connection.collection('classes').countDocuments({})
      : 0;
    const apply = process.argv.includes('--apply');
    const count = sourceExists
      ? await connection.collection('customers').countDocuments({})
      : await connection.collection('classes').countDocuments({});
    console.log(
      JSON.stringify({
        database: connection.name,
        sourceExists,
        targetExists,
        targetCount,
        classCount: count,
        apply,
      }),
    );
    if (sourceExists && targetExists && targetCount > 0)
      throw new Error(
        'Both customers and classes exist; refusing to merge or overwrite either collection',
      );
    if (!sourceExists) {
      if (!targetExists)
        throw new Error('No class collection found; refusing to create an empty replacement');
      console.log(JSON.stringify({ alreadyRenamed: true }));
      return;
    }
    if (!apply) return;
    const before = await Promise.all(names.map(fingerprint));
    // Preserve the pre-created empty target, including its indexes, instead of overwriting it.
    const archivedTarget = targetExists ? `classes_before_rename_${Date.now()}` : undefined;
    if (archivedTarget)
      await connection.collection('classes').rename(archivedTarget, { dropTarget: false });
    await connection.collection('customers').rename('classes', { dropTarget: false });
    const after = await Promise.all(
      names.map((name) =>
        fingerprint(name === 'customers' ? 'classes' : name === 'classes' ? archivedTarget! : name),
      ),
    );
    const allDocumentsUnchanged = before.every((hash, index) => hash === after[index]);
    if (!allDocumentsUnchanged)
      throw new Error('Data changed during rename verification; inspect concurrent activity');
    console.log(
      JSON.stringify({
        renamed: true,
        classCount: count,
        allDocumentsUnchanged,
        verifiedCollections: names.length,
        archivedTarget,
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
