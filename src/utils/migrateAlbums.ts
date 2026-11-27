import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Album from '../models/Album';
import Photo from '../models/Photo';
import BookingAlbum from '../models/BookingAlbum';
import ConceptAlbum from '../models/ConceptAlbum';
import BookingAlbumPhoto from '../models/BookingAlbumPhoto';
import ConceptPhoto from '../models/ConceptPhoto';
import BookingDeliveryPhoto from '../models/BookingDeliveryPhoto';
import { LEGACY_ALBUM_COLLECTIONS, assertSharedAlbumStore } from '../services/sharedAlbumStore';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
type Record = mongoose.mongo.WithId<mongoose.mongo.Document>;
const stores = [...LEGACY_ALBUM_COLLECTIONS, 'albums', 'photos'];
const key = (id: unknown) => String(id);
const models = [
  Album,
  Photo,
  BookingAlbum,
  ConceptAlbum,
  BookingAlbumPhoto,
  ConceptPhoto,
  BookingDeliveryPhoto,
];

async function fingerprint(name: string) {
  const hash = createHash('sha256');
  for await (const row of mongoose.connection.collection(name).find().sort({ _id: 1 }))
    hash.update(mongoose.mongo.BSON.serialize(row));
  return hash.digest('hex');
}

export async function migrateAlbums(apply = false) {
  const connection = mongoose.connection;
  if (connection.name !== 'studio_db' && !/^studio_album_store_test_\d+$/.test(connection.name))
    throw new Error(
      'Album migration only supports studio_db or an isolated album migration test database',
    );
  const existingNames = (
    await connection.db!.listCollections({}, { nameOnly: true }).toArray()
  ).map((row) => row.name);
  const snapshots = new Map<string, Record[]>();
  for (const name of stores)
    snapshots.set(name, await connection.collection(name).find().sort({ _id: 1 }).toArray());
  const albums = new Map<string, Record>();
  const photos = new Map<string, Record>();
  const add = (target: Map<string, Record>, row: Record) => {
    const previous = target.get(key(row._id));
    if (previous && !isDeepStrictEqual(previous, row))
      throw new Error('Conflicting album/photo IDs; refusing to overwrite existing data');
    target.set(key(row._id), row);
  };
  for (const row of snapshots.get('albums')!) add(albums, row);
  for (const row of snapshots.get('photos')!) add(photos, row);
  for (const row of snapshots.get('bookingalbums')!) add(albums, { ...row, service: 'yearbook' });
  for (const row of snapshots.get('conceptalbums')!) add(albums, { ...row, service: 'concept' });
  for (const row of snapshots.get('bookingalbumphotos')!)
    add(photos, { ...row, kind: 'yearbook_drive' });
  for (const row of snapshots.get('conceptphotos')!) {
    const { version, ...content } = row;
    if (!Number.isSafeInteger(version) || version < 0)
      throw new Error('Invalid concept photo version');
    add(photos, { ...content, deliveryVersion: version, kind: 'concept_drive' });
  }
  // Legacy local uploads could exist before a Drive album had been configured.
  let generatedAlbums = 0;
  for (const row of snapshots.get('bookingdeliveryphotos')!) {
    let album = [...albums.values()].find(
      (a) => a.service === 'yearbook' && key(a.booking) === key(row.booking),
    );
    if (!album) {
      album = {
        _id: new mongoose.Types.ObjectId(),
        service: 'yearbook',
        booking: row.booking,
        title: 'Album',
        publicId: randomBytes(18).toString('base64url'),
        version: 0,
        status: 'draft',
        shared: false,
        limit: 0,
        folders: [],
        skipped: [],
        selectionHistory: [],
        requests: [],
        createdAt: row.createdAt ?? new Date(),
        updatedAt: row.updatedAt ?? new Date(),
        __v: 0,
      };
      add(albums, album);
      generatedAlbums++;
    }
    add(photos, { ...row, album: album._id, kind: 'yearbook_upload' });
  }
  for (const row of albums.values()) {
    const model =
      row.service === 'yearbook' ? BookingAlbum : row.service === 'concept' ? ConceptAlbum : null;
    if (
      !model ||
      new model(row).validateSync() ||
      (row.service === 'yearbook' ? !row.booking || !!row.order : !row.order || !!row.booking)
    )
      throw new Error('Invalid album ownership or content');
    const ownerCollection = row.service === 'yearbook' ? 'bookings' : 'conceptorders';
    const ownerId = row.service === 'yearbook' ? row.booking : row.order;
    if (
      !(await connection
        .collection(ownerCollection)
        .findOne({ _id: ownerId }, { projection: { _id: 1 } }))
    )
      throw new Error('Album refers to a missing order');
  }
  for (const row of photos.values()) {
    const album = albums.get(key(row.album));
    const model =
      row.kind === 'yearbook_drive'
        ? BookingAlbumPhoto
        : row.kind === 'concept_drive'
          ? ConceptPhoto
          : row.kind === 'yearbook_upload'
            ? BookingDeliveryPhoto
            : null;
    if (
      !model ||
      new model(row).validateSync() ||
      !album ||
      album.service !== (row.kind === 'concept_drive' ? 'concept' : 'yearbook') ||
      (row.kind === 'yearbook_upload' && key(album.booking) !== key(row.booking))
    )
      throw new Error('Invalid photo or mismatched album ownership');
    if (row.originalPhotoId) {
      const original = photos.get(key(row.originalPhotoId));
      if (!original || original.kind !== 'yearbook_drive' || key(original.album) !== key(row.album))
        throw new Error('Replacement photo refers to an invalid original');
    }
  }
  const counts = Object.fromEntries(stores.map((name) => [name, snapshots.get(name)!.length]));
  console.log(
    JSON.stringify({
      database: connection.name,
      apply,
      counts,
      albums: albums.size,
      photos: photos.size,
      generatedAlbums,
    }),
  );
  if (!apply) return;
  const backupDirectory = await mkdtemp(path.join(os.tmpdir(), 'studio-shared-albums-'));
  const metadata = [];
  for (const name of stores) {
    await writeFile(
      path.join(backupDirectory, `${name}.bson`),
      Buffer.concat(snapshots.get(name)!.map((row) => mongoose.mongo.BSON.serialize(row))),
      { flag: 'wx', mode: 0o600 },
    );
    if (existingNames.includes(name))
      metadata.push({ name, indexes: await connection.collection(name).listIndexes().toArray() });
  }
  await writeFile(
    path.join(backupDirectory, 'manifest.json'),
    JSON.stringify({ database: connection.name, counts, metadata }, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify({ backupDirectory }));
  const untouched = existingNames.filter(
    (name) => !stores.includes(name) && !name.startsWith('system.'),
  );
  const before = await Promise.all(untouched.map(fingerprint));
  for (const model of models) await model.createIndexes();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const name of stores) {
        const current = await connection
          .collection(name)
          .find({}, { session })
          .sort({ _id: 1 })
          .toArray();
        if (!isDeepStrictEqual(current, snapshots.get(name)))
          throw new Error('Album data changed after backup; stop API/worker and retry migration');
      }
      for (const [name, rows] of [
        ['albums', albums],
        ['photos', photos],
      ] as const) {
        const present = new Set(snapshots.get(name)!.map((row) => key(row._id)));
        const inserts = [...rows.values()].filter((row) => !present.has(key(row._id)));
        if (inserts.length) await connection.collection(name).insertMany(inserts, { session });
      }
      for (const name of LEGACY_ALBUM_COLLECTIONS)
        if (snapshots.get(name)!.length)
          await connection.collection(name).deleteMany({}, { session });
    });
  } finally {
    await session.endSession();
  }
  for (const [name, rows] of [
    ['albums', albums],
    ['photos', photos],
  ] as const) {
    const current = await connection.collection(name).find().toArray();
    if (
      current.length !== rows.size ||
      current.some((row) => !isDeepStrictEqual(row, rows.get(key(row._id))))
    )
      throw new Error('Transferred album/photo content does not match the BSON backup');
  }
  await assertSharedAlbumStore();
  for (const name of LEGACY_ALBUM_COLLECTIONS)
    if (existingNames.includes(name)) await connection.collection(name).drop();
  const after = await Promise.all(untouched.map(fingerprint));
  if (before.some((value, i) => value !== after[i]))
    throw new Error('Other business data changed during migration verification');
  console.log(
    JSON.stringify({
      migrated: true,
      albums: albums.size,
      photos: photos.size,
      businessDataUnchanged: true,
      backupDirectory,
    }),
  );
  return { backupDirectory, albums: albums.size, photos: photos.size };
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
    await migrateAlbums(process.argv.includes('--apply'));
  } finally {
    await mongoose.disconnect();
  }
}
if (require.main === module)
  main().catch((error: Error) => {
    console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi, '[REDACTED_URI]'));
    process.exitCode = 1;
  });
