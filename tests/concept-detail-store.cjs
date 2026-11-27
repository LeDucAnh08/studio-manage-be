const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const Detail = require('../src/models/ConceptDetail').default;
const Order = require('../src/models/ConceptOrder').default;
const { assertConceptDetailStore } = require('../src/services/conceptDetailStore');
const { renameConceptDetails } = require('../src/utils/renameConceptDetails');

test('ConceptDetail binds concept_details and preserves the package relation API', async (t) => {
  assert.equal(Detail.modelName, 'ConceptDetail');
  assert.equal(Detail.collection.name, 'concept_details');
  assert.equal(mongoose.models.ConceptPackage, undefined);
  assert.equal(Order.schema.path('package').options.ref, 'ConceptDetail');
  const id = new mongoose.Types.ObjectId();
  const detail = new Detail({ _id: id, name: 'Gói kiểm thử' });
  t.mock.method(Detail, 'find', (filter) => {
    assert.deepEqual(filter._id.$in, [id]);
    return { exec: async () => [detail] };
  });
  const order = new Order({ package: id });
  await order.populate('package');
  assert.equal(String(order.package._id), String(id));
  assert.equal(order.package.name, 'Gói kiểm thử');
});

test(
  'native rename preserves BSON, IDs, indexes and orders; conflicts stop and retries are safe',
  { skip: !process.env.MONGO_TEST_URI },
  async (t) => {
    const ConnectionString = require('mongodb-connection-string-url').default;
    const uri = new ConnectionString(process.env.MONGO_TEST_URI);
    const database = `studio_concept_detail_test_${process.pid}`;
    uri.pathname = '/' + database;
    await mongoose.connect(uri.toString(), {
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
    const row = {
      _id: new mongoose.Types.ObjectId(),
      concept: new mongoose.Types.ObjectId(),
      name: 'Nội dung gói',
      price: 1000000,
      durationMinutes: 60,
      maxPeople: 2,
      retouchQuota: 10,
      extraPhotoPrice: 50000,
      version: 9,
      active: true,
      createdAt: new Date('2026-11-20'),
      updatedAt: new Date('2026-11-21'),
    };
    await db.collection('conceptpackages').insertOne(row);
    await db.collection('conceptpackages').createIndex({ concept: 1 });
    const indexes = await db.collection('conceptpackages').listIndexes().toArray();
    const order = {
      _id: new mongoose.Types.ObjectId(),
      package: row._id,
      snapshot: { name: row.name, price: row.price },
    };
    await db.collection('conceptorders').insertOne(order);
    await assert.rejects(assertConceptDetailStore(), /migration required/);
    await renameConceptDetails(false);
    assert.equal(await db.collection('conceptpackages').countDocuments(), 1);
    await db
      .collection('concept_details')
      .insertOne({ _id: new mongoose.Types.ObjectId(), name: 'Conflicting catalog' });
    await assert.rejects(renameConceptDetails(true), /refusing to overwrite/);
    assert.deepEqual(await db.collection('conceptpackages').findOne(), row);
    await db.collection('concept_details').deleteMany({});
    const result = await renameConceptDetails(true);
    assert.ok(result.archivedTarget);
    assert.deepEqual(await db.collection('concept_details').findOne(), row);
    assert.deepEqual(await db.collection('concept_details').listIndexes().toArray(), indexes);
    assert.deepEqual(await db.collection('conceptorders').findOne(), order);
    const { readFile } = require('node:fs/promises');
    assert.deepEqual(
      mongoose.mongo.BSON.deserialize(
        await readFile(path.join(result.backupDirectory, 'conceptpackages.bson')),
      ),
      row,
    );
    assert.equal((await db.db.listCollections({ name: 'conceptpackages' }).toArray()).length, 0);
    const populated = await Order.findById(order._id).populate('package');
    assert.equal(String(populated.package._id), String(row._id));
    assert.equal(populated.package.name, row.name);
    await assertConceptDetailStore();
    await renameConceptDetails(true);
    assert.equal(await Detail.countDocuments(), 1);
  },
);
