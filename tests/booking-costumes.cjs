// Uses only a disposable local replica-set database; never the application's database.
process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'booking-costume-tests-only';
process.env.CLIENT_PORTAL_ENABLED = 'true';
process.env.CLIENT_WORKFLOW_ENABLED = 'true';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const models = Object.fromEntries(
  [
    'User',
    'Booking',
    'BookingWorkflow',
    'Package',
    'CostumeType',
    'Costume',
    'RentalOrder',
    'Schedule',
    'Customer',
    'Student',
    'Category',
    'Transaction',
  ].map((name) => [name, require(`../src/models/${name}`).default]),
);
const { parseCostumeSelections } = require('../src/services/bookingCostumes');
const { loadRentalHolds, getRentalAvailability } = require('../src/services/rentalAvailability');
const { vietnamDay } = require('../src/utils/rentalPeriod');

test('selection input rejects malformed rows and canonicalizes ordering', () => {
  const id = 'abcdefabcdefabcdefabcdef';
  assert.deepEqual(parseCostumeSelections(undefined), []);
  for (const input of [
    null,
    {},
    [{ costumeId: id, size: 'M', quantity: '1' }],
    [{ costumeId: id, size: 'M', quantity: 1.5 }],
    [{ costumeId: 'bad', size: 'M', quantity: 1 }],
    Array(101).fill({ costumeId: id, size: 'M', quantity: 1 }),
  ])
    assert.throws(() => parseCostumeSelections(input));
  assert.throws(() =>
    parseCostumeSelections([
      { costumeId: id, size: 'M', quantity: 1 },
      { costumeId: id.toUpperCase(), size: ' M ', quantity: 1 },
    ]),
  );
  assert.deepEqual(
    parseCostumeSelections([
      { costumeId: id.toUpperCase(), size: ' S ', quantity: 1 },
      { costumeId: id, size: 'M', quantity: 2 },
    ]),
    [
      { costumeId: id, size: 'M', quantity: 2 },
      { costumeId: id, size: 'S', quantity: 1 },
    ],
  );
});

test('booking costume holds share stock and transfer atomically on a real replica set', async (t) => {
  const uri = new URL(
    process.env.MONGO_TEST_URI ||
      'mongodb://127.0.0.1:27031/?replicaSet=bookingtest&directConnection=true',
  );
  assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname));
  const database = 'studio_booking_costume_test';
  uri.pathname = `/${database}`;
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 5000 });
  assert.equal(mongoose.connection.name, database);
  assert.ok(
    (await mongoose.connection.db.admin().command({ hello: 1 })).setName,
    'Requires a replica set',
  );
  await mongoose.connection.dropDatabase();
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(mongoose.connection.name, database);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  for (const model of Object.values(models)) await model.syncIndexes();
  const users = {};
  for (const [name, roles] of Object.entries({
    admin: [0],
    client: [6],
    stranger: [6],
    photographer: [3],
  }))
    users[name] = await models.User.create({
      username: `costume.${name}`,
      password: 'CostumeTests123!',
      roles,
      isActive: true,
    });
  const kind = await models.CostumeType.create({ name: 'Áo dài' });
  const costume = await models.Costume.create({
    name: 'Áo dài trắng',
    type: kind._id,
    isRentalItem: true,
    rentalPrice: 100000,
    inventory: [
      { size: 'M', quantity: 2, condition: 'good' },
      { size: 'S', quantity: 2, condition: 'good' },
    ],
  });
  const second = await models.Costume.create({
    name: 'Áo dài xanh',
    type: kind._id,
    isRentalItem: false,
    inventory: [{ size: 'M', quantity: 2, condition: 'good' }],
  });
  const accessory = await models.Costume.create({
    name: 'Mũ',
    type: kind._id,
    itemKind: 'accessory',
    inventory: [{ size: 'FREE', quantity: 2, condition: 'good' }],
  });
  const pack = await models.Package.create({
    name: 'Gói chụp',
    pricePerMember: 500000,
    costumes: [kind._id],
  });
  const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const period = {
    receiveDate: vietnamDay(`${day}T08:00:00+07:00`),
    returnDate: vietnamDay(`${day}T10:00:00+07:00`),
  };
  const app = express();
  app.use(express.json());
  app.use('/public', require('../src/routes/public').default);
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use('/costumes', require('../src/routes/costumes').default);
  app.use('/schedules', require('../src/routes/schedules').default);
  app.use('/rentals', require('../src/routes/rentals').default);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ message: error.message }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (
    path,
    actor = users.client,
    body,
    method = body ? 'POST' : 'GET',
    key = randomUUID(),
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...(actor
          ? {
              Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET)}`,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const selection = (quantity = 2, item = costume, size = 'M') => ({
    costumeId: String(item._id),
    size,
    quantity,
  });
  const payload = (lines = [selection()]) => ({
    packageId: String(pack._id),
    className: '12A1',
    members: 2,
    contactName: 'Đại diện',
    phone: '0901234567',
    startAt: `${day}T08:00:00+07:00`,
    endAt: `${day}T10:00:00+07:00`,
    location: 'Hà Nội',
    note: '',
    costumeSelections: lines,
  });
  const create = async (lines, key) => {
    const r = await call('/bookings', users.client, payload(lines), 'POST', key);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data._id;
  };
  const catalog = () =>
    call(
      `/public/packages/${pack._id}/costumes?startAt=${encodeURIComponent(payload().startAt)}&endAt=${encodeURIComponent(payload().endAt)}`,
      null,
    );
  const remaining = async () => {
    const { orders, schedules } = await loadRentalHolds([String(costume._id)]);
    return (
      getRentalAvailability(
        await models.Costume.findById(costume._id).lean(),
        period,
        orders,
        schedules,
      ).M ?? 0
    );
  };
  const review = (id, status = 'approved') =>
    call(`/bookings/${id}/review`, users.admin, { status, note: 'Studio phản hồi' }, 'PATCH');
  const rental = async (status = 'ready_to_confirm') =>
    models.RentalOrder.create({
      client: users.stranger._id,
      creationKey: randomUUID(),
      creationFingerprint: randomUUID(),
      status,
      quote: {
        version: 1,
        lines: [{ ...selection(), name: costume.name, unitPrice: 100000 }],
        ...period,
        fee: 200000,
        deposit: 0,
        acceptedAt: new Date(),
        terms: ['Điều khoản'],
      },
    });
  const rentalConfirm = (order) =>
    call(`/rentals/${order._id}/actions`, users.admin, {
      action: 'resources.confirm',
      expectedVersion: 0,
    });
  t.beforeEach(async () => {
    for (const name of [
      'Booking',
      'BookingWorkflow',
      'RentalOrder',
      'Schedule',
      'Customer',
      'Student',
      'Transaction',
    ])
      await models[name].deleteMany({});
    await models.Costume.updateOne(
      { _id: costume._id },
      { $set: { inventory: costume.inventory.toObject(), type: kind._id, isRentalItem: true } },
    );
  });

  await t.test(
    'public package catalog includes internal clothing, excludes accessories and keeps private stock data hidden',
    async () => {
      const r = await catalog();
      assert.equal(r.status, 200);
      assert.deepEqual(
        r.body.data.map((item) => item._id).sort(),
        [String(costume._id), String(second._id)].sort(),
      );
      assert.deepEqual(
        r.body.data.find((item) => item._id === String(costume._id)).availableBySize,
        { M: 2, S: 2 },
      );
      assert.equal(r.body.data[0].inventory, undefined);
      const unconfigured = await models.Package.create({
        name: 'Gói chưa cấu hình trang phục',
        pricePerMember: 100000,
      });
      await models.Package.collection.updateOne(
        { _id: unconfigured._id },
        { $unset: { costumes: 1 } },
      );
      const empty = await call(
        `/public/packages/${unconfigured._id}/costumes?startAt=${encodeURIComponent(payload().startAt)}&endAt=${encodeURIComponent(payload().endAt)}`,
        null,
      );
      assert.equal(empty.status, 200, JSON.stringify(empty.body));
      assert.deepEqual(empty.body.data, []);
      assert.equal((await call(`/public/packages/${pack._id}/costumes`, null)).status, 400);
    },
  );
  await t.test(
    'booking stores snapshots, limits by type and validates size, quantity and membership',
    async () => {
      for (const rows of [
        [selection(2), selection(1, second)],
        [selection(1, costume, 'XL')],
        [selection(1, accessory, 'FREE')],
        [selection(1), selection(1)],
      ])
        assert.equal((await call('/bookings', users.client, payload(rows))).status, 400);
      assert.equal((await call('/bookings', null, payload())).status, 401);
      const id = await create([selection(1), selection(1, costume, 'S')]);
      const stored = await models.Booking.findById(id);
      assert.equal(stored.costumeSelections[0].typeName, kind.name);
      assert.equal(stored.costumeSelections[0].name, costume.name);
      assert.ok(Math.abs(+stored.costumeHold.expiresAt - +stored.createdAt - 86400000) < 5000);
      assert.equal((await call(`/bookings/${id}`, users.stranger)).status, 404);
      assert.equal(
        (
          await call(
            `/bookings/${id}/costume-hold/release`,
            users.client,
            { note: 'Không dùng' },
            'PATCH',
          )
        ).status,
        403,
      );
      assert.equal(await remaining(), 1);
    },
  );
  await t.test(
    'same key concurrently creates one hold, canonical retries preserve expiry and changed contents conflict',
    async () => {
      const key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          call(
            '/bookings',
            users.client,
            payload([selection(1, costume, 'S'), selection(1)]),
            'POST',
            key,
          ),
        ),
      );
      assert.equal(responses.filter((r) => r.status === 201).length, 1, JSON.stringify(responses));
      assert.ok(
        responses.every((r) => [200, 201].includes(r.status)),
        JSON.stringify(responses),
      );
      const id = responses[0].body.data._id;
      const before = await models.Booking.findById(id);
      assert.equal(
        (
          await call(
            '/bookings',
            users.client,
            payload([selection(1), selection(1, costume, 'S')]),
            'POST',
            key,
          )
        ).status,
        200,
      );
      assert.equal((await call('/bookings', users.client, payload(), 'POST', key)).status, 409);
      assert.equal(
        +(await models.Booking.findById(id)).costumeHold.expiresAt,
        +before.costumeHold.expiresAt,
      );
      assert.equal(await models.Booking.countDocuments(), 1);
    },
  );
  await t.test(
    'only one competing booking can reserve the final stock; failures leave no partial booking',
    async () => {
      const results = await Promise.all([
        call('/bookings', users.client, payload()),
        call('/bookings', users.stranger, payload()),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      const failed = results.find((r) => r.status === 409);
      assert.equal(failed.body.data.costumeConflicts[0].size, 'M');
      assert.equal(await models.Booking.countDocuments(), 1);
      assert.equal(await remaining(), 0);
    },
  );
  await t.test(
    'expiry takes effect on reads without a worker; approval reacquires or fails without changing status',
    async () => {
      const id = await create();
      await models.Booking.updateOne(
        { _id: id },
        { $set: { 'costumeHold.expiresAt': new Date(Date.now() - 1) } },
      );
      assert.equal(await remaining(), 2);
      assert.equal((await call(`/bookings/${id}`)).body.data.costumeHold.status, 'expired');
      const other = await create();
      assert.equal((await review(id)).status, 409);
      assert.equal((await models.Booking.findById(id)).status, 'pending');
      assert.equal((await review(other, 'rejected')).status, 200);
      assert.equal((await review(id)).status, 200);
      assert.equal((await models.Booking.findById(id)).costumeHold.status, 'approved');
      assert.equal(await remaining(), 0);
    },
  );
  await t.test(
    'approval preserves its own hold; rejection and admin release free stock with retained snapshots',
    async () => {
      const id = await create();
      assert.equal((await review(id)).status, 200);
      assert.equal((await models.Booking.findById(id)).costumeHold.expiresAt, undefined);
      assert.equal(
        (await call(`/bookings/${id}/costume-hold/release`, users.admin, { note: '' }, 'PATCH'))
          .status,
        400,
      );
      assert.equal(
        (
          await call(
            `/bookings/${id}/costume-hold/release`,
            users.admin,
            { note: 'Lớp chọn sau' },
            'PATCH',
          )
        ).status,
        200,
      );
      assert.equal(await remaining(), 2);
      const stored = await models.Booking.findById(id);
      assert.equal(stored.costumeSelections.length, 1);
      assert.equal(stored.costumeHold.releaseReason, 'Lớp chọn sau');
      assert.ok(stored.events.some((event) => event.message.includes('Lớp chọn sau')));
    },
  );
  await t.test(
    'booking holds block rental confirmation, and confirmed rentals block bookings',
    async () => {
      const id = await create();
      const order = await rental();
      assert.equal((await rentalConfirm(order)).status, 409);
      await review(id, 'rejected');
      assert.equal((await rentalConfirm(order)).status, 200);
      assert.equal((await call('/bookings', users.client, payload())).status, 409);
    },
  );
  await t.test(
    'a booking and a rental racing for the last stock have exactly one winner',
    async () => {
      const order = await rental();
      const results = await Promise.all([
        call('/bookings', users.client, payload()),
        rentalConfirm(order),
      ]);
      assert.equal(
        results.filter((r) => [200, 201].includes(r.status)).length,
        1,
        JSON.stringify(results),
      );
      assert.equal(results.filter((r) => r.status === 409).length, 1, JSON.stringify(results));
      assert.equal(await remaining(), 0);
    },
  );
  await t.test(
    'existing schedules block bookings and booking holds protect stock, type and deletion even with photography workflow off',
    async () => {
      await models.Schedule.create({
        customer: new mongoose.Types.ObjectId(),
        costumes: [costume._id],
        shootDate: period.receiveDate,
        costumeReservations: [{ costume: costume._id, size: 'M', quantity: 2, ...period }],
        status: 'confirmed',
      });
      assert.equal((await call('/bookings', users.client, payload())).status, 409);
      await models.Schedule.deleteMany({});
      await create();
      process.env.CLIENT_WORKFLOW_ENABLED = 'false';
      try {
        for (const [body, method] of [
          [{ inventory: [{ size: 'M', quantity: 1, condition: 'good' }] }, 'PUT'],
          [{ type: String(new mongoose.Types.ObjectId()) }, 'PUT'],
          [undefined, 'DELETE'],
        ])
          assert.equal(
            (await call(`/costumes/${costume._id}`, users.admin, body, method)).status,
            409,
          );
        const customer = await models.Customer.create({
          className: 'Lớp',
          contactName: 'Liên hệ',
          contactPhone: '0901234567',
          contactAddress: 'Hà Nội',
          total: 2,
        });
        assert.equal(
          (
            await call('/schedules', users.admin, {
              customer: String(customer._id),
              costumes: [String(costume._id)],
              shootDate: period.receiveDate.toISOString(),
              costumeReservations: [
                { costume: String(costume._id), size: 'M', quantity: 1, ...period },
              ],
            })
          ).status,
          409,
        );
      } finally {
        process.env.CLIENT_WORKFLOW_ENABLED = 'true';
      }
    },
  );
  await t.test(
    'inclusive Vietnam days reserve both endpoints and leave neighboring days free',
    async () => {
      const data = payload();
      data.startAt = `${day}T23:30:00+07:00`;
      data.endAt = new Date(Date.parse(`${day}T23:30:00+07:00`) + 3600000).toISOString();
      assert.equal((await call('/bookings', users.client, data)).status, 201);
      const holds = await loadRentalHolds([String(costume._id)]);
      const item = await models.Costume.findById(costume._id).lean();
      for (const offset of [-1, 0, 1, 2]) {
        const date = new Date(+period.receiveDate + offset * 86400000);
        assert.equal(
          getRentalAvailability(
            item,
            { receiveDate: date, returnDate: date },
            holds.orders,
            holds.schedules,
          ).M ?? 0,
          offset === 0 || offset === 1 ? 0 : 2,
        );
      }
    },
  );
  await t.test(
    'workflow transfer excludes its own hold, persists one schedule hold, and cancellation releases stock',
    async () => {
      const id = await create();
      assert.equal((await review(id)).status, 200);
      const action = async (actor, body) => {
        const dto = await call(`/bookings/${id}/workflow`, users.admin);
        const result = await call(`/bookings/${id}/workflow/actions`, actor, {
          expectedVersion: dto.body.data.workflow.version,
          ...body,
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return result.body.data;
      };
      const schedule = {
        shootDate: day,
        startTime: '08:00',
        endTime: '10:00',
        location: 'Hà Nội',
        photographerIds: [String(users.photographer._id)],
      };
      await action(users.admin, {
        action: 'quote.propose',
        quote: {
          lines: [{ label: 'Gói chụp', quantity: 2, unitPrice: 500000 }],
          depositRequired: 1,
          proposedSchedule: schedule,
          delivery: { targetDays: 14 },
          terms: ['Theo thỏa thuận'],
          editingTerms: ['Một lần chỉnh sửa'],
        },
      });
      await action(users.client, { action: 'quote.accept' });
      await action(users.admin, {
        action: 'payment.record',
        kind: 'deposit',
        amount: 1,
        method: 'cash',
      });
      const dto = await call(`/bookings/${id}/workflow`, users.admin);
      const members = await call(`/bookings/${id}/workflow/members`, users.client, {
        expectedVersion: dto.body.data.workflow.version,
        members: [
          { name: 'Bạn A', costumeSizes: [{ costumeId: String(costume._id), size: 'M' }] },
          { name: 'Bạn B', costumeSizes: [{ costumeId: String(costume._id), size: 'M' }] },
        ],
      });
      assert.equal(members.status, 200, JSON.stringify(members.body));
      await action(users.admin, {
        action: 'resources.confirm',
        schedule,
        costumes: [{ ...selection(), receiveDate: day, returnDate: day }],
      });
      assert.equal((await models.Booking.findById(id)).costumeHold.status, 'transferred');
      assert.equal(await models.Schedule.countDocuments({ workflowBooking: id }), 1);
      assert.equal(await remaining(), 0);
      assert.equal((await loadRentalHolds([String(costume._id)])).orders.length, 0);
      assert.equal(
        (
          await call(
            `/bookings/${id}/costume-hold/release`,
            users.admin,
            { note: 'Thử bỏ giữ' },
            'PATCH',
          )
        ).status,
        409,
      );
      const requested = await action(users.client, {
        action: 'change.request',
        kind: 'cancel',
        note: 'Lớp hủy',
      });
      const requestId = requested.workflow.changeRequest._id;
      await action(users.admin, {
        action: 'change.propose',
        requestId,
        proposed: {},
        finalPayable: 0,
        terms: ['Hủy miễn phí'],
      });
      await action(users.client, { action: 'change.accept', requestId });
      assert.equal(await remaining(), 2);
    },
  );
  await t.test(
    'legacy booking without clothing creates no hold and follows existing review',
    async () => {
      const id = await create([]);
      assert.equal((await models.Booking.findById(id)).costumeHold, undefined);
      assert.equal((await review(id)).status, 200);
      assert.equal((await call(`/bookings/${id}/workflow`)).body.data.booking.costumeHold, null);
    },
  );
  await t.test(
    'the first booking hold races safely with stock edits while workflow and rental flags are disabled',
    async () => {
      process.env.CLIENT_WORKFLOW_ENABLED = 'false';
      try {
        const responses = await Promise.all([
          call('/bookings', users.client, payload()),
          call(
            `/costumes/${costume._id}`,
            users.admin,
            {
              inventory: [
                { size: 'M', quantity: 1, condition: 'good' },
                { size: 'S', quantity: 2, condition: 'good' },
              ],
            },
            'PUT',
          ),
        ]);
        assert.equal(
          responses.filter((r) => [200, 201].includes(r.status)).length,
          1,
          JSON.stringify(responses),
        );
        assert.equal(
          responses.filter((r) => r.status === 409).length,
          1,
          JSON.stringify(responses),
        );
      } finally {
        process.env.CLIENT_WORKFLOW_ENABLED = 'true';
      }
    },
  );
  await t.test(
    'missing transaction support returns 503 without creating a booking, while skipping costumes still works',
    async (t) => {
      t.mock.method(mongoose, 'startSession', async () => ({
        withTransaction: async () => {
          throw Object.assign(
            new Error('Transaction numbers are only allowed on a replica set member'),
            { code: 20 },
          );
        },
        endSession: async () => {},
      }));
      assert.equal((await call('/bookings', users.client, payload())).status, 503);
      assert.equal(await models.Booking.countDocuments(), 0);
      await create([]);
    },
  );
  await t.test(
    'cancellation before schedule confirmation releases an approved booking hold',
    async () => {
      const id = await create();
      assert.equal((await review(id)).status, 200);
      const action = async (actor, body) => {
        const current = await call(`/bookings/${id}/workflow`, users.admin);
        const result = await call(`/bookings/${id}/workflow/actions`, actor, {
          expectedVersion: current.body.data.workflow.version,
          ...body,
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return result.body.data;
      };
      await action(users.admin, {
        action: 'quote.propose',
        quote: {
          lines: [{ label: 'Gói', quantity: 2, unitPrice: 500000 }],
          depositRequired: 1,
          proposedSchedule: {
            shootDate: day,
            startTime: '08:00',
            endTime: '10:00',
            location: 'Hà Nội',
          },
          delivery: { targetDays: 14 },
          terms: ['Theo thỏa thuận'],
          editingTerms: [],
        },
      });
      await action(users.client, { action: 'quote.accept' });
      assert.equal(await remaining(), 0);
      const requested = await action(users.client, {
        action: 'change.request',
        kind: 'cancel',
        note: 'Hủy trước khi chốt lịch',
      });
      const requestId = requested.workflow.changeRequest._id;
      await action(users.admin, {
        action: 'change.propose',
        requestId,
        proposed: {},
        finalPayable: 0,
        terms: ['Hủy miễn phí'],
      });
      await action(users.client, { action: 'change.accept', requestId });
      assert.equal((await models.Booking.findById(id)).costumeHold.status, 'released');
      assert.equal(await remaining(), 2);
      assert.equal(await models.Schedule.countDocuments(), 0);
    },
  );
});
