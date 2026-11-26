const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
process.env.CLIENT_PORTAL_ENABLED = 'true';
process.env.JWT_SECRET = 'package-detail-integration-only';
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const Package = require('../src/models/Package').default;
const PackageDetail = require('../src/models/PackageDetail').default;
const Booking = require('../src/models/Booking').default;
const { attachPackageDetails, savePackageDetails } = require('../src/services/packageDetails');
const { readPackageContent } = require('../src/utils/packageContentInput');
const { readPackageAgreement } = require('../src/services/packageBooking');

test('package content has a separate unique relation and no embedded Package schema path', () => {
  assert.equal(Package.schema.path('details'), undefined);
  assert.equal(PackageDetail.collection.collectionName, 'package_details');
  assert.equal(PackageDetail.schema.path('package').options.ref, 'Package');
  assert.equal(PackageDetail.schema.path('package').options.unique, true);
  const record = new Package({
    name: 'Test',
    pricePerMember: 1000,
    details: { audience: 'Ignored' },
  });
  assert.equal(Object.hasOwn(record.toObject(), 'details'), false);
});

test('content reads reject unmigrated or mixed revisions instead of accepting old terms', async (t) => {
  let record;
  t.mock.method(PackageDetail, 'findOne', () => ({ lean: async () => record }));
  await assert.rejects(
    attachPackageDetails({ _id: 'test', detailsVersion: 0, details: { audience: 'Legacy' } }),
    (error) => error.status === 409,
  );
  await assert.rejects(
    attachPackageDetails({ _id: 'test', detailsVersion: 2 }),
    (error) => error.status === 409,
  );
  record = { version: 1, audience: 'Stale' };
  await assert.rejects(
    attachPackageDetails({ _id: 'test', detailsVersion: 2 }),
    (error) => error.status === 409,
  );
});

test(
  'split content commits atomically, rejects races, preserves accepted terms and deletes without orphans',
  { skip: !process.env.MONGO_TEST_URI },
  async (t) => {
    const ConnectionString = require('mongodb-connection-string-url').default;
    let target;
    try {
      target = new ConnectionString(process.env.MONGO_TEST_URI);
    } catch {
      throw new Error('Invalid isolated test connection');
    }
    const database = `studio_package_detail_test_${process.pid}`;
    let server;
    target.pathname = '/' + database;
    await mongoose.connect(target.toString(), {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 15000,
    });
    assert.equal(mongoose.connection.name, database);
    t.after(async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      assert.equal(mongoose.connection.name, database);
      assert.match(database, /^studio_package_detail_test_\d+$/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    await Promise.all([Package.init(), PackageDetail.init(), Booking.init()]);
    const pkg = await Package.create({ name: 'Split detail test', pricePerMember: 500000 });
    assert.equal((await attachPackageDetails(pkg)).details, undefined);
    const content = (label) =>
      readPackageContent(
        {
          version: 0,
          details: { audience: label, depositPolicy: label, deliverables: 'Ảnh theo thỏa thuận' },
        },
        0,
      ).details;
    await savePackageDetails(pkg._id, 0, content('Original'));
    assert.equal(
      Object.hasOwn(await Package.collection.findOne({ _id: pkg._id }), 'details'),
      false,
    );
    assert.equal(await PackageDetail.countDocuments({ package: pkg._id }), 1);
    await assert.rejects(
      PackageDetail.create({ package: pkg._id }),
      (error) => error.code === 11000,
    );
    const current = await attachPackageDetails(await Package.findById(pkg._id).lean());
    const start = new Date('2099-11-01T08:00:00+07:00'),
      end = new Date('2099-11-01T12:00:00+07:00');
    const agreement = readPackageAgreement(
      {
        accepted: true,
        pricePerMember: 500000,
        depositPercent: 30,
        holdHours: 24,
        detailsVersion: 1,
        updatedAt: current.updatedAt.toISOString(),
      },
      current,
      2,
      start,
      end,
    );
    const User = require('../src/models/User').default;
    const client = await User.create({
      username: 'detail.integration.client',
      password: 'TestOnly123!',
      roles: [6],
      isActive: true,
    });
    const express = require('express'),
      jwt = require('jsonwebtoken');
    const app = express();
    app.use(express.json());
    app.use('/bookings', require('../src/routes/bookings').default);
    app.use((error, _req, res, _next) =>
      res.status(error.status || 500).json({ message: error.message }),
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const bookingRequest = () =>
      fetch(`http://127.0.0.1:${server.address().port}/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt.sign({ id: String(client._id) }, process.env.JWT_SECRET)}`,
        },
        body: JSON.stringify({
          packageId: String(pkg._id),
          members: 2,
          contactName: 'Test',
          phone: '0901234567',
          startAt: start.toISOString(),
          endAt: end.toISOString(),
          location: 'Studio',
          packageAgreement: {
            accepted: true,
            pricePerMember: 500000,
            depositPercent: 30,
            holdHours: 24,
            detailsVersion: 1,
            updatedAt: current.updatedAt.toISOString(),
          },
        }),
      });
    const booked = await bookingRequest();
    assert.equal(booked.status, 201, await booked.clone().text());
    const bookingId = (await booked.json()).data._id;
    const booking = await Booking.findById(bookingId);
    assert.ok(agreement.terms.includes('Original'));
    const snapshot = (await Booking.findById(booking._id).lean()).packageAgreement;
    assert.ok(snapshot.terms.includes('Original'));

    await assert.rejects(
      savePackageDetails(pkg._id, 0, content('Stale')),
      (error) => error.status === 409,
    );
    const mock = t.mock.method(PackageDetail, 'findOneAndUpdate', () => {
      throw new Error('Injected content write failure');
    });
    await assert.rejects(savePackageDetails(pkg._id, 1, content('Rollback')), /Injected/);
    mock.mock.restore();
    assert.equal((await Package.findById(pkg._id).lean()).detailsVersion, 1);
    assert.equal((await PackageDetail.findOne({ package: pkg._id }).lean()).audience, 'Original');
    const races = await Promise.allSettled([
      savePackageDetails(pkg._id, 1, content('A')),
      savePackageDetails(pkg._id, 1, content('B')),
    ]);
    assert.equal(races.filter((row) => row.status === 'fulfilled').length, 1);
    assert.equal(
      races.filter((row) => row.status === 'rejected' && row.reason.status === 409).length,
      1,
    );
    const latest = await attachPackageDetails(await Package.findById(pkg._id).lean());
    assert.equal(latest.detailsVersion, 2);
    assert.ok(['A', 'B'].includes(latest.details.audience));
    assert.deepEqual((await Booking.findById(booking._id).lean()).packageAgreement, snapshot);
    assert.equal((await bookingRequest()).status, 409);
    const imageId = '00000000-0000-4000-8000-000000000001.webp';
    await savePackageDetails(pkg._id, 2, {
      ...content('Gallery'),
      gallery: [{ id: imageId, alt: 'Test', caption: '', width: 10, height: 10 }],
    });
    let removedImages;
    t.mock.method(require('../src/services/packageMedia'), 'deletePackageImages', async (ids) => {
      removedImages = ids;
    });
    const { remove } = require('../src/controllers/packageController');
    let status;
    await remove(
      { params: { id: String(pkg._id) } },
      {
        status: (value) => {
          status = value;
          return { json: () => {} };
        },
      },
    );
    assert.equal(status, 200);
    assert.equal(await Package.countDocuments({ _id: pkg._id }), 0);
    assert.equal(await PackageDetail.countDocuments({ package: pkg._id }), 0);
    assert.deepEqual(removedImages, [imageId]);
    assert.deepEqual((await Booking.findById(booking._id).lean()).packageAgreement, snapshot);
  },
);
