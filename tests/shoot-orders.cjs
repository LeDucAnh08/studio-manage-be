const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
process.env.CONCEPT_BOOKING_ENABLED = 'true';
process.env.JWT_SECRET = 'shoot-orders-test-only';
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Booking = require('../src/models/Booking').default;
const Workflow = require('../src/models/BookingWorkflow').default;
const ConceptOrder = require('../src/models/ConceptOrder').default;

test('combined staff shoot orders preserve roles, both services, global pagination and existing summaries', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
  const database = `studio_shoot_orders_test_${process.pid}`;
  uri.pathname = `/${database}`;
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 5000 });
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    assert.equal(mongoose.connection.name, database);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  const actors = {};
  for (const [name, roles] of [
    ['admin', [0]],
    ['manager', [1]],
    ['sale', [2]],
    ['a', [3]],
    ['b', [3]],
    ['mixed', [3, 5]],
    ['salesPhoto', [2, 3]],
    ['accountant', [5]],
    ['client', [6]],
    ['other', [4]],
  ])
    actors[name] = await User.create({
      username: 'shoot.' + name,
      name,
      roles,
      isActive: true,
      password: 'TestOnly123!',
    });
  const books = await Booking.create(
    Array.from({ length: 26 }, (_, index) => ({
      client: actors.client._id,
      package: new mongoose.Types.ObjectId(),
      packageName: `Gói lớp ${index}`,
      pricePerMember: 500000,
      packageSnapshot: { name: 'Gói lớp', pricePerMember: 500000 },
      members: 30,
      className: `Lớp ${index}`,
      school: 'THPT',
      contactName: 'Khách',
      phone: '0901234567',
      startAt: new Date('2099-01-02T01:00:00Z'),
      endAt: new Date('2099-01-02T03:00:00Z'),
      location: 'Studio',
      status: index < 4 ? 'approved' : 'pending',
    })),
  );
  await Workflow.create(
    [actors.a, actors.b, actors.mixed, actors.salesPhoto].map((actor, index) => ({
      booking: books[index]._id,
      lifecycle: 'confirmed',
      assignedPhotographer: actor._id,
    })),
  );
  const concepts = await ConceptOrder.create(
    Array.from({ length: 6 }, (_, index) => ({
      client: actors.client._id,
      concept: new mongoose.Types.ObjectId(),
      package: new mongoose.Types.ObjectId(),
      photographer: [actors.a, actors.b, actors.mixed, actors.salesPhoto, actors.a, actors.a][index]
        ._id,
      snapshot: { name: `Gói concept ${index}`, conceptName: 'Chân dung', price: 1000000 },
      contactName: `Khách concept ${index}`,
      phone: '0901234567',
      people: 1,
      startAt: new Date('2099-01-03T01:00:00Z'),
      endAt: new Date('2099-01-03T02:00:00Z'),
      originalStartAt: new Date('2099-01-03T01:00:00Z'),
      reservation: { status: 'transferred', expiresAt: new Date('2099-01-01') },
      status: index === 0 ? 'awaiting_deposit' : index === 5 ? 'cancelled' : 'confirmed',
      checkoutKey: `shoot-key-${index}`,
      fingerprint: `fingerprint-${index}`,
    })),
  );
  const app = express();
  app.use('/workflows', require('../src/routes/workflows').default);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const call = async (actor = 'admin', query = '', route = '/shoot-orders') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/workflows${route}${query}`, {
      headers: actor
        ? { Authorization: `Bearer ${jwt.sign({ id: actors[actor].id }, process.env.JWT_SECRET)}` }
        : {},
    });
    return { status: res.status, body: await res.json() };
  };
  await t.test(
    'managers see pending yearbooks without workflows and concept orders in a single paginated feed',
    async () => {
      for (const actor of ['admin', 'manager', 'accountant']) {
        const result = await call(actor, '?limit=50');
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.pagination.total, 32);
        assert.equal(result.body.data.filter((r) => r.service === 'concept').length, 6);
        const pending = result.body.data.find((r) => r.bookingId === books[25].id);
        assert.equal(pending.orderStage, 'pending');
        assert.equal(pending.bookingStatus, 'pending');
      }
      const first = await call('admin');
      const second = await call('admin', '?page=2');
      assert.equal(first.body.data.length, 20);
      assert.equal(second.body.data.length, 12);
      assert.equal(
        new Set([...first.body.data, ...second.body.data].map((r) => r.service + ':' + r.bookingId))
          .size,
        32,
      );
    },
  );
  await t.test(
    'type and status filters apply before count/pagination and share confirmed-window stages',
    async () => {
      const result = await call('admin', '?service=concept&limit=2&page=2');
      assert.equal(result.body.pagination.total, 6);
      assert.equal(result.body.data.length, 2);
      assert.ok(result.body.data.every((r) => r.service === 'concept'));
      const pending = await call('admin', '?stage=pending&page=2');
      assert.equal(pending.body.pagination.total, 22);
      assert.equal(pending.body.data.length, 2);
      const cancelled = await call('admin', '?stage=cancelled');
      assert.equal(cancelled.body.pagination.total, 1);
      assert.equal(cancelled.body.data[0].bookingId, concepts[5].id);
      const legacy = await call('admin', '?stage=confirmed', '');
      const combined = await call('admin', '?service=yearbook&stage=confirmed');
      assert.deepEqual(
        combined.body.data.map(({ service, ...row }) => row),
        legacy.body.data,
      );
    },
  );
  await t.test(
    'sales keep concept-only access; photographer and accountant combinations cannot broaden personal assignments',
    async () => {
      assert.equal((await call('sale')).body.pagination.total, 6);
      assert.equal((await call('sale', '?service=yearbook')).status, 403);
      for (const actor of ['a', 'mixed']) {
        const result = await call(actor);
        assert.equal(result.status, 200);
        assert.equal(result.body.pagination.total, actor === 'a' ? 4 : 2);
        assert.ok(
          result.body.data.every(
            (r) =>
              r.payment === undefined &&
              r.conceptNetReceived === undefined &&
              r.phone === undefined,
          ),
        );
      }
      const combinedRoles = await call('salesPhoto');
      assert.equal(combinedRoles.body.pagination.total, 7);
      assert.equal(
        (await call('accountant', '?service=concept')).body.data[0].conceptNetReceived,
        0,
      );
      for (const actor of ['client', 'other']) assert.equal((await call(actor)).status, 403);
      assert.equal((await call(null)).status, 401);
    },
  );
  await t.test('validates filters and respects the concept feature gate', async () => {
    for (const query of [
      '?service=rental',
      '?service[]=concept',
      '?stage=unknown',
      '?page=0',
      '?limit=51',
    ])
      assert.equal((await call('admin', query)).status, 400);
    process.env.CONCEPT_BOOKING_ENABLED = 'false';
    try {
      assert.equal((await call('admin')).body.pagination.total, 26);
      assert.equal((await call('admin', '?service=concept')).status, 400);
      assert.equal((await call('sale')).body.pagination.total, 0);
    } finally {
      process.env.CONCEPT_BOOKING_ENABLED = 'true';
    }
  });
});
