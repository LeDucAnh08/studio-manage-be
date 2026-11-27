const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const Album = require('../src/models/Album').default;
const Photo = require('../src/models/Photo').default;
const YearbookAlbum = require('../src/models/BookingAlbum').default;
const ConceptAlbum = require('../src/models/ConceptAlbum').default;
const YearbookPhoto = require('../src/models/BookingAlbumPhoto').default;
const ConceptPhoto = require('../src/models/ConceptPhoto').default;
const Upload = require('../src/models/BookingDeliveryPhoto').default;
const { migrateAlbums } = require('../src/utils/migrateAlbums');
const {
  LEGACY_ALBUM_COLLECTIONS,
  assertSharedAlbumStore,
} = require('../src/services/sharedAlbumStore');

test('service models share two collections and reject ambiguous album ownership', async () => {
  for (const model of [Album, YearbookAlbum, ConceptAlbum])
    assert.equal(model.collection.name, 'albums');
  for (const model of [Photo, YearbookPhoto, ConceptPhoto, Upload])
    assert.equal(model.collection.name, 'photos');
  assert.equal(Photo.schema.path('album').options.ref, 'Album');
  const id = new mongoose.Types.ObjectId();
  await assert.rejects(
    new YearbookAlbum({ booking: id, order: id, title: 'Invalid', publicId: 'invalid' }).validate(),
  );
  await assert.rejects(new ConceptAlbum({ title: 'Missing order' }).validate());
  await assert.rejects(new Album({ title: 'Missing service', booking: id }).validate());
});

test(
  'BSON migration preserves IDs/content, rolls back failures and isolates both services',
  { skip: !process.env.MONGO_TEST_URI },
  async (t) => {
    const ConnectionString = require('mongodb-connection-string-url').default;
    const target = new ConnectionString(process.env.MONGO_TEST_URI);
    const database = `studio_album_store_test_${process.pid}`;
    target.pathname = '/' + database;
    await mongoose.connect(target.toString(), {
      autoCreate: false,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    t.after(async () => {
      assert.equal(mongoose.connection.name, database);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    const db = mongoose.connection;
    const oid = () => new mongoose.Types.ObjectId();
    const booking = oid(),
      conceptOrder = oid(),
      uploadOnlyBooking = oid();
    await db
      .collection('bookings')
      .insertMany([{ _id: booking, protected: 'Keep original order' }, { _id: uploadOnlyBooking }]);
    await db
      .collection('conceptorders')
      .insertOne({ _id: conceptOrder, protected: 'Keep payments' });
    const stamp = new Date('2026-11-20T10:00:00Z');
    const yearbook = new YearbookAlbum({
      booking,
      title: 'Kỉ yếu',
      publicId: 'yearbook-shared-album-test',
      tokenHash: 'secret-yearbook',
      shared: true,
      version: 7,
      status: 'closed',
      selectionHistory: [{ round: 1, photos: ['original'] }],
      folders: [{ id: 'folder01', resourceKey: 'key' }],
      createdAt: stamp,
      updatedAt: stamp,
    }).toObject();
    delete yearbook.service;
    const concept = new ConceptAlbum({
      order: conceptOrder,
      title: 'Concept',
      version: 12,
      status: 'delivered',
      deliveryVersion: 1,
      extraAmount: 50000,
      feedbackRounds: [{ id: 'round1', version: 1 }],
      share: {
        publicId: 'concept-shared-album-test',
        tokenHash: 'secret-concept',
        expiresAt: new Date('2099-01-01'),
      },
      createdAt: stamp,
      updatedAt: stamp,
    }).toObject();
    delete concept.service;
    const original = new YearbookPhoto({
      album: yearbook._id,
      drive: { id: 'drive01', checksum: 'original', resourceKey: 'private' },
      order: 0,
      selected: true,
      note: 'Giữ ghi chú',
      createdAt: stamp,
      updatedAt: stamp,
    }).toObject();
    delete original.kind;
    const conceptPhoto = new ConceptPhoto({
      album: concept._id,
      deliveryVersion: 1,
      drive: { id: 'drive01', checksum: 'edited' },
      order: 0,
      createdAt: stamp,
      updatedAt: stamp,
    }).toObject();
    conceptPhoto.version = conceptPhoto.deliveryVersion;
    delete conceptPhoto.deliveryVersion;
    delete conceptPhoto.kind;
    const upload = new Upload({
      booking,
      album: yearbook._id,
      originalPhotoId: original._id,
      uploadedBy: oid(),
      uploadKey: 'keep-upload-key',
      sha256: 'keep-sha',
      name: 'Ảnh chỉnh',
      width: 100,
      height: 80,
      bytes: 123,
      publishedVersions: [1, 2],
      createdAt: stamp,
      updatedAt: stamp,
    }).toObject();
    delete upload.kind;
    delete upload.album;
    const standalone = {
      ...upload,
      _id: oid(),
      booking: uploadOnlyBooking,
      uploadKey: 'standalone',
      publishedVersions: [],
    };
    delete standalone.originalPhotoId;
    for (const [name, rows] of [
      ['bookingalbums', [yearbook]],
      ['conceptalbums', [concept]],
      ['bookingalbumphotos', [original]],
      ['conceptphotos', [conceptPhoto]],
      ['bookingdeliveryphotos', [upload, standalone]],
    ])
      await db.collection(name).insertMany(rows);
    await db
      .collection('bookingalbumselections')
      .insertOne({ album: yearbook._id, round: 1, driveId: 'drive01', name: 'Original' });
    const ownerBefore = await db.collection('bookings').find().toArray();
    const selectionBefore = await db.collection('bookingalbumselections').find().toArray();
    await assert.rejects(assertSharedAlbumStore(), /migration required/);
    await migrateAlbums(false);
    assert.equal(await db.collection('albums').countDocuments(), 0);
    await db
      .collection('albums')
      .insertOne({ ...yearbook, service: 'yearbook', title: 'Conflicting target' });
    await assert.rejects(migrateAlbums(true), /Conflicting album\/photo IDs/);
    assert.equal(await db.collection('bookingalbums').countDocuments(), 1);
    assert.equal(
      (await db.collection('albums').findOne({ _id: yearbook._id })).title,
      'Conflicting target',
    );
    await db.collection('albums').deleteOne({ _id: yearbook._id });
    const mock = t.mock.method(db.collection('photos'), 'insertMany', () => {
      throw new Error('Injected migration failure');
    });
    await assert.rejects(migrateAlbums(true), /Injected/);
    mock.mock.restore();
    assert.equal(await db.collection('albums').countDocuments(), 0);
    assert.equal(await db.collection('bookingalbums').countDocuments(), 1);
    const result = await migrateAlbums(true);
    const { readFile } = require('node:fs/promises');
    assert.deepEqual(
      mongoose.mongo.BSON.deserialize(
        await readFile(path.join(result.backupDirectory, 'conceptalbums.bson')),
      ),
      concept,
    );
    assert.equal(await Album.countDocuments(), 3);
    assert.equal(await Photo.countDocuments(), 4);
    await assertSharedAlbumStore();
    assert.equal(await YearbookAlbum.findById(concept._id), null);
    assert.equal(await ConceptAlbum.findById(yearbook._id), null);
    assert.equal(await ConceptPhoto.findById(original._id), null);
    assert.equal(await YearbookPhoto.findById(conceptPhoto._id), null);
    assert.equal(await Upload.findById(original._id), null);
    const migrated = await db.collection('photos').findOne({ _id: conceptPhoto._id });
    const { version, ...content } = conceptPhoto;
    assert.deepEqual(migrated, { ...content, deliveryVersion: version, kind: 'concept_drive' });
    assert.deepEqual(await db.collection('albums').findOne({ _id: yearbook._id }), {
      ...yearbook,
      service: 'yearbook',
    });
    assert.deepEqual(await db.collection('albums').findOne({ _id: concept._id }), {
      ...concept,
      service: 'concept',
    });
    assert.deepEqual(await db.collection('photos').findOne({ _id: upload._id }), {
      ...upload,
      album: yearbook._id,
      kind: 'yearbook_upload',
    });
    const standaloneAlbum = await YearbookAlbum.findOne({ booking: uploadOnlyBooking });
    assert.equal(standaloneAlbum.status, 'draft');
    assert.equal(
      String((await Upload.findById(standalone._id)).album),
      String(standaloneAlbum._id),
    );
    assert.deepEqual(await db.collection('bookings').find().toArray(), ownerBefore);
    assert.deepEqual(
      await db.collection('bookingalbumselections').find().toArray(),
      selectionBefore,
    );
    assert.equal(
      (await db.db.listCollections({}, { nameOnly: true }).toArray()).some((row) =>
        LEGACY_ALBUM_COLLECTIONS.includes(row.name),
      ),
      false,
    );
    await assert.rejects(
      YearbookAlbum.create({ booking, title: 'Duplicate', publicId: 'other' }),
      (error) => error.code === 11000,
    );
    await assert.rejects(
      ConceptAlbum.create({ order: conceptOrder, title: 'Duplicate' }),
      (error) => error.code === 11000,
    );
    const photo = await ConceptPhoto.findById(conceptPhoto._id);
    photo.note = 'Lưu lại trong bảng chung';
    await photo.save();
    assert.equal((await db.collection('photos').findOne({ _id: photo._id })).note, photo.note);
    await migrateAlbums(true);
    assert.equal(await Photo.countDocuments(), 4);
    assert.equal(await Album.countDocuments(), 3);
  },
);
