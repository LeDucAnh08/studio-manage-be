const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'booking-expiry-test-only';
process.env.CLIENT_PORTAL_ENABLED = 'true';
process.env.CLIENT_WORKFLOW_ENABLED = 'true';
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const Booking = require('../src/models/Booking').default;
const Workflow = require('../src/models/BookingWorkflow').default;
const Schedule = require('../src/models/Schedule').default;
const User = require('../src/models/User').default;
const {
  bookingExpiryCutoff,
  expirePendingBookings,
  startBookingExpiry,
  BOOKING_EXPIRY_REASON,
} = require('../src/services/bookingExpiry');
const DATABASE = 'studio_booking_expiry_test';

test('unreviewed bookings expire after their requested Vietnam calendar day', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname));
  uri.pathname = `/${DATABASE}`;
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, DATABASE);
  assert.ok(
    (await mongoose.connection.db.admin().command({ hello: 1 })).setName,
    'Transactions need a replica set',
  );
  await mongoose.connection.dropDatabase();
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(mongoose.connection.name, DATABASE);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await Promise.all([Booking.init(), Workflow.init(), Schedule.init(), User.init()]);
  const [admin, client, other] = await User.create(
    ['admin', 'client', 'other'].map((name) => ({
      username: `expiry.${name}`,
      password: 'ExpiryTest123!',
      name,
      roles: name === 'admin' ? [0] : [6],
      isActive: true,
    })),
  );
  t.beforeEach(async () => {
    await Promise.all([Booking.deleteMany({}), Workflow.deleteMany({}), Schedule.deleteMany({})]);
  });
  const create = (startAt, status = 'pending', extra = {}) =>
    Booking.create({
      client: client._id,
      package: new mongoose.Types.ObjectId(),
      packageName: 'Gói kiểm thử',
      pricePerMember: 500000,
      packageSnapshot: { name: 'Gói kiểm thử', pricePerMember: 500000 },
      members: 1,
      className: '12A1',
      contactName: 'Khách thử',
      phone: '0901234567',
      location: 'Studio',
      startAt,
      endAt: new Date(new Date(startAt).getTime() + 3600000),
      status,
      ...extra,
    });
  const app = express();
  app.use(express.json());
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use('/workflows', require('../src/routes/workflows').default);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const call = async (url, user = admin, body, method = body ? 'POST' : 'GET') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const boundary = new Date('2030-03-02T00:00:00+07:00');

  await t.test(
    'cancels only on the next Vietnam day, retains history and does not alter reviewed or future bookings',
    async () => {
      assert.equal(bookingExpiryCutoff(boundary).toISOString(), '2030-03-01T17:00:00.000Z');
      const old = await create('2030-03-01T00:05:00+07:00');
      const today = await create('2030-03-02T00:00:00+07:00');
      const approved = await create('2030-03-01T08:00:00+07:00', 'approved');
      const rejected = await create('2030-03-01T08:00:00+07:00', 'rejected');
      assert.equal(await expirePendingBookings(new Date('2030-03-01T23:59:59.999+07:00')), 0);
      assert.equal(await expirePendingBookings(boundary), 1);
      const stored = await Booking.findById(old._id).lean();
      assert.equal(stored.status, 'cancelled');
      assert.equal(stored.cancelledAt.toISOString(), boundary.toISOString());
      assert.equal(stored.cancellationReason, BOOKING_EXPIRY_REASON);
      assert.deepEqual(
        stored.events.map((row) => row.audience),
        ['client', 'admin'],
      );
      assert.equal((await Booking.findById(today._id)).status, 'pending');
      assert.equal((await Booking.findById(approved._id)).status, 'approved');
      assert.equal((await Booking.findById(rejected._id)).status, 'rejected');
      assert.equal(await expirePendingBookings(boundary), 0);
      assert.equal((await Booking.findById(old._id)).events.length, 2);
    },
  );

  await t.test(
    'cancels an early workflow, increments its version and releases clothing together, once under concurrent retries',
    async () => {
      const booking = await create('2030-03-01T08:00:00+07:00', 'pending', {
        costumeHold: {
          status: 'temporary',
          receiveDate: '2030-03-01',
          returnDate: '2030-03-02',
          expiresAt: '2030-03-03',
        },
      });
      await Workflow.create({ booking: booking._id, version: 3, lifecycle: 'intake' });
      const counts = await Promise.all([
        expirePendingBookings(boundary),
        expirePendingBookings(boundary),
      ]);
      assert.equal(
        counts.reduce((sum, count) => sum + count, 0),
        1,
      );
      const stored = await Booking.findById(booking._id).lean();
      const workflow = await Workflow.findOne({ booking: booking._id }).lean();
      assert.equal(stored.costumeHold.status, 'released');
      assert.equal(stored.costumeHold.releaseReason, BOOKING_EXPIRY_REASON);
      assert.equal(workflow.lifecycle, 'cancelled');
      assert.equal(workflow.version, 4);
      assert.equal(workflow.events.filter((row) => row.action === 'booking.expire').length, 1);
    },
  );

  await t.test(
    'does not cancel inconsistent intake that already has committed resources or money',
    async () => {
      const booking = await create('2030-03-01T08:00:00+07:00');
      await Workflow.create({
        booking: booking._id,
        lifecycle: 'confirmed',
        resources: { schedule: new mongoose.Types.ObjectId() },
      });
      const paid = await create('2030-03-01T08:00:00+07:00');
      await Workflow.create({
        booking: paid._id,
        lifecycle: 'intake',
        payments: [
          {
            kind: 'deposit',
            amount: 100000,
            method: 'cash',
            receivedAt: new Date(),
            recordedBy: admin._id,
          },
        ],
      });
      assert.equal(await expirePendingBookings(boundary), 0);
      assert.equal((await Booking.findById(booking._id)).status, 'pending');
      assert.equal((await Workflow.findOne({ booking: booking._id })).lifecycle, 'confirmed');
      assert.equal((await Booking.findById(paid._id)).status, 'pending');
      assert.equal((await Workflow.findOne({ booking: paid._id })).payments.length, 1);
    },
  );

  await t.test('concurrent approval and expiry never overwrite each other', async () => {
    const booking = await create('2030-03-01T08:00:00+07:00');
    const [cancelled, approved] = await Promise.all([
      expirePendingBookings(boundary),
      Booking.findOneAndUpdate(
        { _id: booking._id, status: 'pending' },
        { $set: { status: 'approved' } },
        { new: true },
      ),
    ]);
    const stored = await Booking.findById(booking._id);
    assert.ok(['approved', 'cancelled'].includes(stored.status));
    assert.equal(Number(!!approved) + cancelled, 1);
    assert.equal(stored.events.length, stored.status === 'cancelled' ? 2 : 0);
  });

  await t.test(
    'reads immediately settle overdue requests, paginate correctly and expose the cancellation to its owner',
    async () => {
      const yesterday = new Date(bookingExpiryCutoff().getTime() - 12 * 3600000);
      const booking = await create(yesterday);
      const pending = await call('/workflows?status=pending');
      assert.equal(pending.body.pagination.total, 0);
      const cancelled = await call('/workflows?view=cancelled', client);
      assert.equal(cancelled.body.pagination.total, 1);
      assert.equal(cancelled.body.data[0].bookingStatus, 'cancelled');
      assert.equal(cancelled.body.data[0].lifecycle, 'cancelled');
      assert.equal((await call('/workflows?view=active', client)).body.pagination.total, 0);
      assert.equal((await call('/workflows?view=cancelled', other)).body.pagination.total, 0);
      const detail = await call(`/bookings/${booking._id}/workflow`, client);
      assert.equal(detail.body.data.booking.cancellationReason, BOOKING_EXPIRY_REASON);
      assert.equal(detail.body.data.workflow.lifecycle, 'cancelled');
      assert.equal((await call(`/bookings/${booking._id}`, other)).status, 404);
      assert.equal((await call('/bookings?status=cancelled', client)).body.pagination.total, 1);
      assert.equal(
        (
          await call(
            `/bookings/${booking._id}/review`,
            admin,
            { status: 'approved', note: 'Duyệt muộn' },
            'PATCH',
          )
        ).status,
        409,
      );
      const notifications = await call('/bookings/notifications', client);
      assert.ok(notifications.body.data.some((row) => row.message === BOOKING_EXPIRY_REASON));
      assert.equal((await Booking.findById(booking._id)).events.length, 2);
    },
  );

  await t.test('startup and periodic worker both settle overdue intake', async (sub) => {
    let callback;
    let interval;
    let unref = false;
    sub.mock.method(global, 'setInterval', (fn, milliseconds) => {
      callback = fn;
      interval = milliseconds;
      return {
        unref() {
          unref = true;
        },
      };
    });
    const yesterday = new Date(bookingExpiryCutoff().getTime() - 12 * 3600000);
    const first = await create(yesterday);
    startBookingExpiry();
    const waitCancelled = async (id) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await Booking.findById(id)).status === 'cancelled') return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail('Expiry worker did not settle the booking');
    };
    await waitCancelled(first._id);
    assert.equal(interval, 60000);
    assert.equal(unref, true);
    // Let the transaction and worker's finally block finish before the next tick.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await create(yesterday);
    callback();
    await waitCancelled(second._id);
  });
});
