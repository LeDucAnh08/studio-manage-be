import { createHash } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ensureRoles } from '../services/roles';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function accountSnapshot(): Promise<string> {
  const hash = createHash('sha256');
  // Raw BSON detects any account change, including password, roles and timestamps.
  for await (const user of mongoose.connection.collection('users').find().sort({ _id: 1 }))
    hash.update(mongoose.mongo.BSON.serialize(user));
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
      throw new Error('Role migration is restricted to the configured studio_db database');
    const collection = mongoose.connection.collection('roles');
    const before = await accountSnapshot();
    const rolesBefore = await collection.find().sort({ _id: 1 }).toArray();
    const apply = process.argv.includes('--apply');
    console.log(JSON.stringify({ database: mongoose.connection.name, apply, rolesBefore }));
    if (!apply) return;

    const inserted = await ensureRoles();
    const rolesAfter = await collection.find().sort({ _id: 1 }).toArray();
    const accountsUnchanged = before === (await accountSnapshot());
    console.log(JSON.stringify({ inserted, rolesAfter, accountsUnchanged }));
    if (!accountsUnchanged)
      throw new Error(
        'Accounts changed during verification; migration only writes the roles collection',
      );
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
