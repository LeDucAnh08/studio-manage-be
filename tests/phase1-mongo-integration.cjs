process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'phase1-integration-secret';
process.env.CLIENT_PORTAL_ENABLED = 'true';

const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('ts-node/register/transpile-only');

const User = require('../src/models/User').default;
const Booking = require('../src/models/Booking').default;
const Package = require('../src/models/Package').default;
const AccountRequest = require('../src/models/AccountRequest').default;

const TEST_DATABASE = 'studio_phase1_integration';

function isolatedMongoUri() {
  const source = process.env.MONGO_TEST_URI || process.env.MONGO_URI;
  assert.ok(source, 'Set MONGO_TEST_URI or backend/.env MONGO_URI to a local MongoDB instance');
  const uri = new URL(source);
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(uri.hostname),
    'Phase 1 integration tests refuse to use a non-local MongoDB host',
  );
  uri.pathname = `/${TEST_DATABASE}`;
  return uri.toString();
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth').default);
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use('/account-requests', require('../src/routes/accountRequests').default);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  return app;
}

test('Phase 1 persists idempotent bookings and single-winner approvals in MongoDB', async (t) => {
  await mongoose.connect(isolatedMongoUri());
  assert.equal(mongoose.connection.name, TEST_DATABASE);
  await mongoose.connection.dropDatabase();
  await Promise.all([
    User.syncIndexes(),
    Booking.syncIndexes(),
    Package.syncIndexes(),
    AccountRequest.syncIndexes(),
  ]);

  const [admin, client, otherClient] = await User.create([
    {
      username: 'phase1.integration.admin',
      name: 'Phase 1 Admin',
      password: 'integration-pass-123',
      roles: [0],
      isActive: true,
    },
    {
      username: 'phase1.integration.client',
      name: 'Khách tích hợp',
      password: 'integration-pass-123',
      roles: [6],
      isActive: true,
    },
    {
      username: 'phase1.integration.other',
      name: 'Khách khác',
      password: 'integration-pass-123',
      roles: [6],
      isActive: true,
    },
  ]);
  const selectedPackage = await Package.create({
    name: 'Gói tích hợp Phase 1',
    pricePerMember: 500000,
    duration: 'full_day',
    description: 'Dữ liệu test cô lập',
  });

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(mongoose.connection.name, TEST_DATABASE);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (user) => jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
  const call = (pathName, user, body, method = body ? 'POST' : 'GET', headers = {}) =>
    fetch(base + pathName, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { Authorization: `Bearer ${token(user)}` } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const bookingPayload = {
    packageId: String(selectedPackage._id),
    members: 30,
    contactName: 'Khách tích hợp',
    phone: '0901234567',
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    location: 'Hà Nội',
    note: 'Integration test',
  };

  await t.test('concurrent retries create one booking with a package snapshot', async () => {
    const responses = await Promise.all(
      [1, 2].map(() =>
        call('/bookings', client, bookingPayload, 'POST', {
          'Idempotency-Key': 'phase1-integration-booking-0001',
        }),
      ),
    );
    const outcomes = await Promise.all(
      responses.map(async (response) => ({ status: response.status, body: await response.json() })),
    );
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status).sort(),
      [200, 201],
      JSON.stringify(outcomes),
    );
    assert.equal(await Booking.countDocuments(), 1);
    const stored = await Booking.findOne().lean();
    assert.equal(stored.packageSnapshot.name, selectedPackage.name);
    assert.equal(stored.packageSnapshot.pricePerMember, selectedPackage.pricePerMember);
  });

  const booking = await Booking.findOne();
  await t.test('a different client cannot read the booking', async () => {
    assert.equal((await call(`/bookings/${booking._id}`, otherClient)).status, 404);
  });

  await t.test('only one concurrent booking review wins', async () => {
    const responses = await Promise.all(
      ['approved', 'rejected'].map((status) =>
        call(
          `/bookings/${booking._id}/review`,
          admin,
          { status, note: 'Đã kiểm tra khả năng phục vụ' },
          'PATCH',
        ),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    const stored = await Booking.findById(booking._id).lean();
    assert.ok(['approved', 'rejected'].includes(stored.status));
    assert.equal(stored.events.length, 4);
  });

  await t.test('only one concurrent staff-account approval creates a user', async () => {
    const request = await AccountRequest.create({
      username: 'phase1.integration.staff',
      name: 'Nhân sự tích hợp',
      passwordHash: '$2a$12$FqQ3M4U.3P4frd2g5Vv.wO0lg1S.MxVqP2C3v5u2SLK9W9v5jFZla',
      requestedRole: 3,
    });
    const responses = await Promise.all(
      [1, 2].map(() =>
        call(
          `/account-requests/${request._id}`,
          admin,
          { status: 'approved', roles: [3], note: 'Đã xác minh' },
          'PATCH',
        ),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    assert.equal(await User.countDocuments({ sourceAccountRequest: request._id }), 1);
    const stored = await AccountRequest.findById(request._id).select('+passwordHash').lean();
    assert.equal(stored.status, 'approved');
    assert.equal(stored.passwordHash, undefined);
  });
});
