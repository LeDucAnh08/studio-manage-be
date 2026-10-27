// Real MongoDB, restricted to a dedicated disposable local test database.
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'customer-order-views-test';
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Booking = require('../src/models/Booking').default;
const BookingWorkflow = require('../src/models/BookingWorkflow').default;
const TEST_DATABASE = 'studio_customer_order_views_test';

test('customer order views filter all pages, retain legacy intake and isolate each owner', async (t) => {
  const source = process.env.MONGO_TEST_URI || process.env.MONGO_URI;
  assert.ok(source, 'Configure a local MongoDB test URI');
  const uri = new URL(source);
  assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
  uri.pathname = `/${TEST_DATABASE}`;
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, TEST_DATABASE);
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(mongoose.connection.name, TEST_DATABASE);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await mongoose.connection.dropDatabase();
  const [owner, other] = await User.create(
    ['owner', 'other'].map((name) => ({
      username: `orders.${name}`,
      name,
      password: 'OrdersTest123!',
      roles: [6],
      isActive: true,
    })),
  );
  const records = await Booking.create(
    Array.from({ length: 26 }, (_, index) => ({
      client: index === 25 ? other._id : owner._id,
      package: new mongoose.Types.ObjectId(),
      packageName: `Gói ${index}`,
      pricePerMember: 500000,
      packageSnapshot: { name: `Gói ${index}`, pricePerMember: 500000 },
      members: 37,
      className: '12A1',
      school: 'THPT Yume',
      contactName: 'Khách thử',
      phone: '0901234567',
      startAt: '2026-11-19T07:30:00+07:00',
      endAt: '2026-11-19T15:00:00+07:00',
      location: 'Studio',
      status: index === 3 ? 'rejected' : index < 3 || index === 25 ? 'approved' : 'pending',
    })),
  );
  await BookingWorkflow.create([
    { booking: records[0]._id, lifecycle: 'confirmed' },
    { booking: records[1]._id, lifecycle: 'completed' },
    { booking: records[2]._id, lifecycle: 'cancelled' },
    { booking: records[25]._id, lifecycle: 'completed' },
  ]);
  const app = express();
  app.use('/workflows', require('../src/routes/workflows').default);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const call = (query = '', user = owner) =>
    fetch(`http://127.0.0.1:${server.address().port}/workflows${query}`, {
      headers: user
        ? { Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}` }
        : {},
    });
  assert.equal((await call('', null)).status, 401);
  const all = await (await call()).json();
  assert.equal(all.pagination.total, 25);
  assert.equal(all.data.length, 20);
  assert.ok(all.data.every((item) => item.school === 'THPT Yume'));
  const active = await (await call('?view=active')).json();
  assert.equal(active.pagination.total, 22);
  assert.ok(
    active.data.every(
      (item) =>
        !['completed', 'cancelled'].includes(item.lifecycle) && item.bookingStatus !== 'rejected',
    ),
  );
  assert.ok(active.data.some((item) => item.lifecycle === 'intake'));
  const next = await (await call('?view=active&page=2')).json();
  assert.equal(next.pagination.total, 22);
  assert.equal(next.data.length, 2);
  for (const [view, index] of [
    ['completed', 1],
    ['cancelled', 2],
    ['rejected', 3],
  ]) {
    const result = await (await call(`?view=${view}`)).json();
    assert.equal(result.pagination.total, 1);
    assert.equal(result.data[0].bookingId, String(records[index]._id));
  }
  const theirs = await (await call('?view=completed', other)).json();
  assert.equal(theirs.pagination.total, 1);
  assert.equal(theirs.data[0].bookingId, String(records[25]._id));
  assert.equal((await call('?view=unknown')).status, 400);
  assert.equal((await call('?view[]=active')).status, 400);
});
