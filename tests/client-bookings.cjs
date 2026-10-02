// HTTP contract tests with isolated model doubles: no real database or customer data.
process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'isolated-test-secret';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Booking = require('../src/models/Booking').default;
const Package = require('../src/models/Package').default;
const AccountRequest = require('../src/models/AccountRequest').default;
const clients = {
  '000000000000000000000001': { _id: '000000000000000000000001', roles: [6], isActive: true },
  '000000000000000000000002': { _id: '000000000000000000000002', roles: [6], isActive: true },
  '000000000000000000000003': { _id: '000000000000000000000003', roles: [0], isActive: true },
  '000000000000000000000004': { _id: '000000000000000000000004', roles: [3], isActive: true },
  '000000000000000000000005': { _id: '000000000000000000000005', roles: [1], isActive: true },
};
let record;
let createdUser;
let bookingCreateCount = 0;
User.findById = (id) => ({ select: async () => clients[id] });
User.findOne = async () => null;
User.create = async (data) => {
  createdUser = data;
  return data;
};
AccountRequest.exists = async () => false;
Package.findById = async () => ({
  _id: '000000000000000000000010',
  name: 'Gói thử',
  pricePerMember: 500000,
});
Booking.create = async (data) => {
  bookingCreateCount += 1;
  record = {
    ...data,
    _id: '000000000000000000000020',
    events: data.events.map((event, index) => ({ ...event, _id: String(index), at: new Date() })),
  };
  return record;
};
Booking.updateOne = async (filter, update) => {
  if (record && record.client === filter.client && record.clientRequestId === filter.clientRequestId)
    return { acknowledged: true, upsertedCount: 0 };
  bookingCreateCount += 1;
  const data = update.$setOnInsert;
  record = {
    ...data,
    _id: '000000000000000000000020',
    events: data.events.map((event, index) => ({ ...event, _id: String(index), at: new Date() })),
  };
  return { acknowledged: true, upsertedCount: 1 };
};
Booking.findOne = (filter) => ({
  select: () => ({
    lean: async () => {
      if (!record) return null;
      if (filter.clientRequestId) {
        return filter.client === record.client && filter.clientRequestId === record.clientRequestId
          ? record
          : null;
      }
      return filter._id === record._id && (!filter.client || filter.client === record.client)
        ? record
        : null;
    },
  }),
});
Booking.findOneAndUpdate = async (filter, update) => {
  if (!record || record.status !== filter.status || record.startAt <= filter.startAt.$gt)
    return null;
  Object.assign(record, update.$set);
  record.events.push(...update.$push.events.$each);
  return record;
};
test('Client registration and booking permissions over HTTP', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth').default);
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use('/users', require('../src/routes/users').default);
  app.use('/packages', require('../src/routes/packages').default);
  app.use((err, req, res, next) => res.status(500).json({ message: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, id, body, method = body ? 'POST' : 'GET', headers = {}) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(id ? { Authorization: 'Bearer ' + jwt.sign({ id }, process.env.JWT_SECRET) } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const [alice, bob, admin, staff, manager] = Object.keys(clients);
  const data = {
    packageId: '000000000000000000000010',
    members: 2,
    contactName: 'Khách thử',
    phone: '0901234567',
    startAt: new Date(Date.now() + 86400000).toISOString(),
    endAt: new Date(Date.now() + 90000000).toISOString(),
    location: 'Hà Nội',
    note: '',
  };
  await t.test('feature flag can disable public registration and booking routes', async () => {
    process.env.CLIENT_PORTAL_ENABLED = 'false';
    assert.equal(
      (
        await call('/auth/register', null, {
          username: 'disabled.client',
          name: 'Disabled Client',
          password: 'test-pass-123',
        })
      ).status,
      503,
    );
    assert.equal((await call('/bookings', alice)).status, 503);
    process.env.CLIENT_PORTAL_ENABLED = 'true';
  });
  await t.test('public registration cannot assign internal roles', async () => {
    const r = await call('/auth/register', null, {
      username: 'Client.Test',
      name: 'Khách',
      password: 'test-pass-123',
      roles: [0],
      isActive: false,
    });
    assert.equal(r.status, 201);
    assert.equal(createdUser.username, 'client.test');
    assert.deepEqual(createdUser.roles, [6]);
    assert.equal(createdUser.isActive, true);
  });
  await t.test('reject weak password and object username', async () => {
    assert.equal(
      (
        await call('/auth/register', null, {
          username: { $ne: null },
          name: 'Test',
          password: 'short',
        })
      ).status,
      400,
    );
  });
  await t.test('anonymous cannot create booking', async () =>
    assert.equal((await call('/bookings', null, data)).status, 401),
  );
  await t.test('client cannot read internal staff directory', async () =>
    assert.equal((await call('/users/photographers', alice)).status, 403),
  );
  await t.test('user management rejects unsafe roles and unknown fields', async () => {
    assert.equal(
      (
        await call('/users', admin, {
          username: 'mixed-role',
          password: 'test-pass-123',
          roles: [3, 6],
          isActive: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call('/users', manager, {
          username: 'new-superadmin',
          password: 'test-pass-123',
          roles: [0],
          isActive: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call('/users', admin, {
          username: 'Manual.Staff',
          password: 'test-pass-123',
          roles: [2],
          isActive: true,
          sourceAccountRequest: 'attacker-controlled',
        })
      ).status,
      201,
    );
    assert.equal(createdUser.username, 'manual.staff');
    assert.equal(createdUser.sourceAccountRequest, undefined);
  });
  await t.test('internal package endpoints require authentication', async () =>
    assert.equal((await call('/packages', null)).status, 401),
  );
  await t.test('invalid or past time is rejected', async () =>
    assert.equal((await call('/bookings', alice, { ...data, startAt: '2020-01-01' })).status, 400),
  );
  await t.test('ownership, price and status cannot be supplied by client', async () => {
    assert.equal(
      (
        await call('/bookings', alice, {
          ...data,
          client: bob,
          pricePerMember: 1,
          status: 'approved',
        })
      ).status,
      201,
    );
    assert.equal(record.client, alice);
    assert.equal(record.status, 'pending');
    assert.equal(record.pricePerMember, 500000);
    assert.equal(record.packageSnapshot.name, 'Gói thử');
    assert.equal(record.packageSnapshot.pricePerMember, 500000);
  });
  await t.test('retry with the same idempotency key does not create another booking', async () => {
    const before = bookingCreateCount;
    const headers = { 'Idempotency-Key': 'booking-request-0001' };
    const first = await call('/bookings', alice, data, 'POST', headers);
    const retry = await call('/bookings', alice, data, 'POST', headers);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(bookingCreateCount, before + 1);
    assert.equal(
      (await call('/bookings', alice, { ...data, members: 3 }, 'POST', headers)).status,
      409,
    );
  });
  await t.test('invalid pagination is rejected', async () => {
    assert.equal((await call('/bookings?page=0', alice)).status, 400);
    assert.equal((await call('/bookings?limit=51', alice)).status, 400);
  });
  await t.test('other client cannot read booking', async () =>
    assert.equal((await call('/bookings/' + record._id, bob)).status, 404),
  );
  await t.test('owner can read only customer event audience', async () => {
    const r = await call('/bookings/' + record._id, alice);
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.data.events.length, 1);
    assert.equal(json.data.events[0].audience, 'client');
  });
  await t.test('client and staff cannot review', async () => {
    for (const id of [alice, staff])
      assert.equal(
        (
          await call(
            '/bookings/' + record._id + '/review',
            id,
            { status: 'approved', note: 'Đã kiểm tra' },
            'PATCH',
          )
        ).status,
        403,
      );
  });
  await t.test('admin must give feedback', async () =>
    assert.equal(
      (
        await call(
          '/bookings/' + record._id + '/review',
          admin,
          { status: 'rejected', note: '' },
          'PATCH',
        )
      ).status,
      400,
    ),
  );
  await t.test(
    'one review wins and both notification audiences persist with decision',
    async () => {
      const responses = await Promise.all(
        ['approved', 'rejected'].map((status) =>
          call(
            '/bookings/' + record._id + '/review',
            admin,
            { status, note: 'Phản hồi thử' },
            'PATCH',
          ),
        ),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      assert.equal(record.events.length, 4);
    },
  );
});
