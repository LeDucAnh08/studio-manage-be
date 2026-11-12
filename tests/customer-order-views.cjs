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
const Schedule = require('../src/models/Schedule').default;
const { bookingOrderStage, bookingShootWindow } = require('../src/services/bookingOrderStage');
const TEST_DATABASE = 'studio_customer_order_views_test';

test('ongoing shoots use only the confirmed Vietnam time window, including exact boundaries', () => {
  const schedule = { shootDate: '2026-11-19T17:00:00Z', startTime: '08:00', endTime: '16:00' };
  const start = Date.parse('2026-11-20T08:00:00+07:00');
  const end = Date.parse('2026-11-20T16:00:00+07:00');
  assert.deepEqual(bookingShootWindow(schedule), {
    startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
  });
  for (const lifecycle of ['confirmed', 'shooting', 'editing', 'revision_requested', 'change_pending']) {
    const workflow = { lifecycle, changeRequest: { previousLifecycle: 'shooting' } };
    for (const [now, stage] of [[start - 1, 'confirmed'], [start, 'active'], [end - 1, 'active'], [end, 'editing'], [end + 1, 'editing']])
      assert.equal(bookingOrderStage('approved', workflow, schedule, now), stage, `${lifecycle} at ${now}`);
    assert.notEqual(bookingOrderStage('approved', workflow, null, start), 'active');
    assert.notEqual(bookingOrderStage('approved', workflow, { ...schedule, endTime: '07:00' }, start), 'active');
  }
  for (const lifecycle of ['delivered', 'accepted', 'completed', 'cancelled'])
    assert.equal(bookingOrderStage('approved', { lifecycle }, schedule, start),
      lifecycle === 'accepted' ? 'delivered' : lifecycle);
  for (const status of ['pending', 'rejected', 'cancelled'])
    assert.equal(bookingOrderStage(status, { lifecycle: 'shooting' }, schedule, start), status);
});

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
  app.get('/workflows/:id', require('../src/middleware/auth').protect,
    require('../src/middleware/asyncHandler').asyncHandler(require('../src/controllers/workflowController').getWorkflow));
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
  const pending = await (await call('?status=pending')).json();
  assert.equal(pending.pagination.total, 21);
  assert.ok(pending.data.every((row) => row.bookingStatus === 'pending'));
  const processing = await (await call('?view=active&status=approved')).json();
  assert.equal(processing.pagination.total, 1);
  assert.equal(processing.data[0].bookingId, String(records[0]._id));
  assert.equal((await (await call('?view=rejected&status=pending')).json()).pagination.total, 0);
  assert.equal((await (await call('?status=pending', other)).json()).pagination.total, 0);
  assert.equal((await call('?status=unknown')).status, 400);
  assert.equal((await call('?status[]=pending')).status, 400);
  assert.equal((await call('?view=unknown')).status, 400);
  assert.equal((await call('?view[]=active')).status, 400);

  await t.test('stage filters exactly match displayed stages before pagination', async () => {
    const examples = [
      ['pending', 'intake', 'pending'],
      ['approved', undefined, 'awaiting_confirmation'],
      ['approved', 'quoting', 'awaiting_confirmation'],
      ['approved', 'awaiting_deposit', 'awaiting_confirmation'],
      ['approved', 'ready_to_confirm', 'awaiting_confirmation'],
      ['approved', 'confirmed', 'confirmed'],
      ['approved', 'shooting', 'confirmed'],
      ['approved', 'editing', 'editing'],
      ['approved', 'revision_requested', 'editing'],
      ['approved', 'delivered', 'delivered'],
      ['approved', 'accepted', 'delivered'],
      ['approved', 'completed', 'completed'],
      ['approved', 'cancelled', 'cancelled'],
      ['cancelled', 'intake', 'cancelled'],
      ['rejected', 'intake', 'rejected'],
      ['approved', 'change_pending', 'editing', 'editing'],
      ['approved', 'change_pending', 'delivered', 'accepted'],
      ['approved', 'change_pending', 'confirmed', 'confirmed'],
      ['approved', 'change_pending', 'awaiting_confirmation'],
      ['approved', 'change_pending', 'confirmed', undefined, true],
    ];
    const expected = new Map(
      all.data
        .concat((await (await call('?page=2')).json()).data)
        .map((row) => [row.bookingId, row.orderStage]),
    );
    for (const [status, lifecycle, stage, previousLifecycle, hasSchedule] of examples) {
      const booking = await Booking.create({
        ...records[0].toObject(),
        _id: new mongoose.Types.ObjectId(),
        status,
      });
      if (lifecycle)
        await BookingWorkflow.create({
          booking: booking._id,
          lifecycle,
          ...(hasSchedule
            ? {
                resources: {
                  schedule: new mongoose.Types.ObjectId(),
                  photographers: [],
                  costumes: [],
                },
              }
            : {}),
          ...(previousLifecycle
            ? { changeRequest: { kind: 'change', status: 'requested', previousLifecycle } }
            : {}),
        });
      expected.set(String(booking._id), stage);
    }
    // A schedule can differ from the original request. Filters must use that actual schedule.
    const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    for (const offset of [-1, 0, 1]) {
      const shootDate = new Date(Date.parse(`${today}T00:00:00+07:00`) + offset * 86400000);
      for (const lifecycle of ['confirmed', 'shooting', 'editing', 'revision_requested']) {
        const booking = await Booking.create({ ...records[0].toObject(), _id: new mongoose.Types.ObjectId() });
        const schedule = await Schedule.create({ customer: new mongoose.Types.ObjectId(), shootDate, startTime: '00:00', endTime: '23:59', status: 'confirmed' });
        await BookingWorkflow.create({ booking: booking._id, lifecycle, resources: { schedule: schedule._id } });
        expected.set(String(booking._id), bookingOrderStage('approved', { lifecycle }, schedule));
        const detail = await (await call(`/${booking._id}`)).json();
        assert.equal(detail.data.workflow.orderStage, expected.get(String(booking._id)));
        assert.deepEqual(detail.data.workflow.shootWindow, bookingShootWindow(schedule));
      }
    }
    for (const stage of [
      'pending',
      'awaiting_confirmation',
      'confirmed',
      'active',
      'editing',
      'delivered',
      'completed',
      'cancelled',
      'rejected',
    ]) {
      const ids = [];
      let page = 1;
      let total;
      do {
        const response = await call(`?stage=${stage}&limit=2&page=${page++}`);
        assert.equal(response.status, 200);
        const result = await response.json();
        total = result.pagination.total;
        assert.ok(result.data.every((row) => row.orderStage === stage));
        ids.push(...result.data.map((row) => row.bookingId));
      } while (ids.length < total);
      assert.deepEqual(
        ids.sort(),
        [...expected]
          .filter(([, value]) => value === stage)
          .map(([id]) => id)
          .sort(),
        stage,
      );
    }
    assert.equal((await call('?stage=unknown')).status, 400);
    assert.equal((await call('?stage[]=pending')).status, 400);
    assert.equal((await (await call('?stage=confirmed', other)).json()).pagination.total, 0);
    assert.equal((await (await call('?stage=completed', other)).json()).pagination.total, 1);
  });
});
