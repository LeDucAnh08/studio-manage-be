const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'photographer-assignment-test';
process.env.CLIENT_PORTAL_ENABLED = 'true';
process.env.CLIENT_WORKFLOW_ENABLED = 'true';
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Booking = require('../src/models/Booking').default;
const Workflow = require('../src/models/BookingWorkflow').default;
const Schedule = require('../src/models/Schedule').default;
const Block = require('../src/models/PhotographerUnavailability').default;
const Customer = require('../src/models/Customer').default;
const {
  photographerAvailability,
  parsePhotographerInterval,
} = require('../src/services/photographerAvailability');
const DATABASE = 'studio_photographer_assignment_test';
// Keep integration tests entirely local, including successful legacy schedule writes.
const google = require('../src/services/googleSheetService');
google.createFolderAndLog = async () => null;
google.deleteFolderAndRow = async () => undefined;
require('../src/services/telegramService').notifyUsers = async () => undefined;

test('photographer assignment, availability and personal busy time', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(uri.hostname),
    'Only a disposable local database is allowed',
  );
  uri.pathname = `/${DATABASE}`;
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, DATABASE);
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
  await Promise.all([User.init(), Booking.init(), Workflow.init(), Schedule.init(), Block.init()]);
  const [admin, client, a, b, other, inactive] = await User.create(
    [
      ['admin', [0], true],
      ['client', [6], true],
      ['a', [3], true],
      ['b', [3], true],
      ['other', [3], true],
      ['inactive', [3], false],
    ].map(([name, roles, isActive]) => ({
      username: `assignment.${name}`,
      name,
      roles,
      isActive,
      password: 'Assignment123!',
    })),
  );
  const app = express();
  app.use(express.json());
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use('/workflows', require('../src/routes/workflows').default);
  app.use('/photographers', require('../src/routes/photographerAvailability').default);
  app.use('/schedules', require('../src/routes/schedules').default);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let key = 0;
  const call = async (url, user = admin, body, method = body ? 'POST' : 'GET', headers = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET)}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const action = async (booking, user, data, expected = 200, idempotencyKey) => {
    const workflow = await Workflow.findOne({ booking: booking._id }).lean();
    const result = await call(
      `/bookings/${booking._id}/workflow/actions`,
      user,
      { expectedVersion: workflow?.version ?? 0, ...data },
      'POST',
      { 'Idempotency-Key': idempotencyKey || `assignment-test-${++key}` },
    );
    assert.equal(result.status, expected, JSON.stringify(result.body));
    return result.body.data;
  };
  const makeBooking = (day, start = '08:00', end = '11:00') =>
    Booking.create({
      client: client._id,
      package: new mongoose.Types.ObjectId(),
      packageName: 'Test',
      pricePerMember: 500000,
      packageSnapshot: { name: 'Test', pricePerMember: 500000 },
      members: 1,
      contactName: 'Khách thử',
      phone: '0901234567',
      startAt: `2027-01-${day}T${start}:00+07:00`,
      endAt: `2027-01-${day}T${end}:00+07:00`,
      location: 'Studio',
      note: 'Yêu cầu chụp',
      status: 'approved',
    });
  const ready = async (booking, photographer) => {
    await Workflow.findOneAndUpdate(
      { booking: booking._id },
      {
        $set: {
          lifecycle: 'ready_to_confirm',
          assignedPhotographer: photographer._id,
          quote: {
            version: 1,
            lines: [{ label: 'Test', quantity: 1, unitPrice: 500000 }],
            depositRequired: 0,
            currency: 'VND',
            proposedBy: admin._id,
            proposedAt: new Date(),
            acceptedAt: new Date(),
            acceptedBy: client._id,
            proposedSchedule: {
              shootDate: booking.startAt,
              startTime: booking.startAt.toLocaleTimeString('en-GB', {
                timeZone: 'Asia/Ho_Chi_Minh',
                hour: '2-digit',
                minute: '2-digit',
              }),
              endTime: booking.endAt.toLocaleTimeString('en-GB', {
                timeZone: 'Asia/Ho_Chi_Minh',
                hour: '2-digit',
                minute: '2-digit',
              }),
              location: 'Studio',
            },
            delivery: { targetDays: 14 },
          },
          members: [{ name: 'Thành viên', costumeSizes: [] }],
        },
      },
      { upsert: true },
    );
  };
  const confirm = async (booking, photographer, supports = []) => {
    const wf = await Workflow.findOne({ booking: booking._id }).lean();
    return action(booking, admin, {
      action: 'resources.confirm',
      schedule: {
        ...wf.quote.proposedSchedule,
        photographerIds: [photographer, ...supports].map((person) => String(person._id)),
      },
      costumes: [],
    });
  };
  const manual = (day, startTime, endTime, photographer = a, extra = {}) =>
    Schedule.create({
      customer: new mongoose.Types.ObjectId(),
      shootDate: `2027-01-${day}T00:00:00+07:00`,
      startTime,
      endTime,
      leadPhotographer: photographer._id,
      status: 'confirmed',
      ...extra,
    });
  const availability = (day, start, end) =>
    photographerAvailability(
      parsePhotographerInterval(
        `2027-01-${day}T${start}:00+07:00`,
        `2027-01-${day}T${end}:00+07:00`,
      ),
    );
  const status = (rows, person = a) => rows.find((row) => row._id === String(person._id))?.status;

  await t.test(
    'early assignment grants scoped contact access without reserving time, with idempotency',
    async () => {
      const booking = await makeBooking('03');
      await action(
        booking,
        admin,
        { action: 'photographer.assign', photographerId: String(a._id) },
        200,
        'assignment-repeat-001',
      );
      await action(
        booking,
        admin,
        { action: 'photographer.assign', photographerId: String(a._id) },
        200,
        'assignment-repeat-001',
      );
      assert.equal((await Workflow.findOne({ booking: booking._id })).version, 1);
      assert.equal(await Schedule.countDocuments(), 0);
      const second = await makeBooking('03');
      await action(second, admin, { action: 'photographer.assign', photographerId: String(a._id) });
      const view = await call(`/bookings/${booking._id}/workflow`, a);
      assert.equal(view.body.data.booking.phone, booking.phone);
      assert.equal(view.body.data.booking.note, booking.note);
      assert.equal(view.body.data.workflow.payments, null);
      assert.equal(view.body.data.workflow.quote, null);
      assert.equal((await call(`/bookings/${booking._id}/workflow`, other)).status, 404);
      assert.equal((await call('/workflows?view=active', a)).body.pagination.total, 2);
      assert.equal(
        (await call('/bookings', admin)).body.data.find((r) => r._id === String(booking._id))
          .assignedPhotographer.name,
        'a',
      );
      await action(
        booking,
        a,
        { action: 'photographer.assign', photographerId: String(b._id) },
        403,
      );
      await action(booking, a, { action: 'progress.update', status: 'shooting' }, 403);
      await action(booking, a, { action: 'payment.record', kind: 'deposit', amount: 1 }, 403);
      await action(booking, admin, {
        action: 'photographer.assign',
        photographerId: String(b._id),
      });
      assert.equal((await call(`/bookings/${booking._id}/workflow`, a)).status, 404);
      assert.equal(
        (await call(`/bookings/${booking._id}/workflow`, client)).body.data.workflow
          .assignedPhotographer.name,
        'b',
      );
      await action(
        booking,
        admin,
        { action: 'photographer.assign', photographerId: String(inactive._id) },
        400,
      );
    },
  );

  await t.test(
    '60 minute buffer works in both directions, for support staff and across midnight',
    async () => {
      await manual('05', '08:00', '11:00');
      assert.equal(status(await availability('05', '11:59', '13:00')), 'busy');
      assert.equal(status(await availability('05', '12:00', '13:00')), 'available');
      assert.equal(status(await availability('05', '06:00', '07:01')), 'busy');
      assert.equal(status(await availability('05', '06:00', '07:00')), 'available');
      await manual('06', '22:00', '23:30', b, { supportPhotographers: [a._id] });
      assert.equal(status(await availability('07', '00:29', '01:00')), 'busy');
      assert.equal(status(await availability('07', '00:30', '01:00')), 'available');
      assert.equal(status(await availability('06', '21:00', '22:00')), 'busy');
      assert.ok(
        !(await availability('05', '12:00', '13:00')).some(
          (row) => row._id === String(inactive._id),
        ),
      );
    },
  );

  await t.test(
    'missing times are unknown, terminal schedules do not block, own schedule is excluded by server',
    async () => {
      await manual('08', undefined, undefined);
      assert.equal(status(await availability('08', '08:00', '09:00')), 'unknown');
      await manual('09', '08:00', '11:00', a, { status: 'cancelled' });
      await manual('09', '08:00', '11:00', a, { status: 'completed' });
      assert.equal(status(await availability('09', '08:00', '11:00')), 'available');
      const booking = await makeBooking('10');
      await ready(booking, a);
      const dto = await confirm(booking, a);
      const query = new URLSearchParams({
        bookingId: String(booking._id),
        startAt: booking.startAt.toISOString(),
        endAt: booking.endAt.toISOString(),
      });
      assert.equal(
        status((await call(`/photographers/availability?${query}`)).body.data),
        'available',
      );
      assert.equal((await call(`/photographers/availability?${query}`, other)).status, 403);
      assert.ok(dto.workflow.resources.scheduleId);
    },
  );

  await t.test(
    'personal busy CRUD is owner scoped, has no buffer and cannot overlap held shoots',
    async () => {
      const body = {
        startAt: '2027-01-12T08:00:00+07:00',
        endAt: '2027-01-12T11:00:00+07:00',
        note: 'Nghỉ riêng',
        photographerId: String(b._id),
      };
      const saved = await call('/photographers/unavailability', a, body);
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      assert.equal(
        String(saved.body.data.photographer),
        String(a._id),
        'self cannot create a block for another person',
      );
      const id = saved.body.data._id;
      assert.equal(status(await availability('12', '09:00', '10:00')), 'busy');
      assert.equal(status(await availability('12', '11:00', '12:00')), 'available');
      assert.equal(
        (await call(`/photographers/unavailability?photographerId=${a._id}`, b)).body.data.length,
        0,
      );
      assert.equal((await call(`/photographers/unavailability/${id}`, b, body, 'PUT')).status, 404);
      assert.equal(
        (await call(`/photographers/unavailability/${id}`, b, undefined, 'DELETE')).status,
        404,
      );
      assert.equal(
        (
          await call(
            `/photographers/unavailability/${id}`,
            a,
            { ...body, endAt: '2027-01-12T10:00:00+07:00' },
            'PUT',
          )
        ).status,
        200,
      );
      assert.equal(
        (await call(`/photographers/unavailability/${id}`, admin, undefined, 'DELETE')).status,
        200,
      );
      const held = await call('/photographers/unavailability', a, {
        ...body,
        startAt: '2027-01-05T09:00:00+07:00',
        endAt: '2027-01-05T10:00:00+07:00',
      });
      assert.equal(held.status, 409);
      assert.equal((await call('/photographers/unavailability', client, body)).status, 403);
      assert.equal(
        (await call('/photographers/unavailability', a, { ...body, endAt: body.startAt })).status,
        400,
      );
    },
  );

  await t.test(
    'confirmed reassignment updates lead atomically, preserves supports and legacy fallback',
    async () => {
      const booking = await makeBooking('14');
      await ready(booking, a);
      const dto = await confirm(booking, a);
      await Schedule.updateOne(
        { _id: dto.workflow.resources.scheduleId },
        { $set: { supportPhotographers: [other._id] } },
      );
      await Workflow.updateOne(
        { booking: booking._id },
        {
          $set: { 'resources.photographers': [a._id, other._id] },
          $unset: { assignedPhotographer: '', assignedSupportPhotographers: '' },
        },
      );
      assert.equal(
        (await call(`/bookings/${booking._id}/workflow`)).body.data.workflow.assignedPhotographer
          .name,
        'a',
      );
      await action(booking, admin, {
        action: 'photographer.assign',
        photographerId: String(b._id),
      });
      const schedule = await Schedule.findById(dto.workflow.resources.scheduleId);
      assert.equal(String(schedule.leadPhotographer), String(b._id));
      assert.deepEqual(schedule.supportPhotographers.map(String), [String(other._id)]);
      assert.equal((await call(`/bookings/${booking._id}/workflow`, a)).status, 404);
      assert.equal((await call(`/bookings/${booking._id}/workflow`, other)).status, 200);
      await action(booking, b, { action: 'progress.update', status: 'shooting' });
      await action(
        booking,
        admin,
        { action: 'photographer.assign', photographerId: String(a._id) },
        409,
      );
    },
  );

  await t.test(
    'assignment is frozen while a change is pending and cannot bypass availability',
    async () => {
      const booking = await makeBooking('05', '08:30', '10:00');
      await action(
        booking,
        admin,
        { action: 'photographer.assign', photographerId: String(a._id) },
        409,
      );
      await ready(booking, b);
      await Workflow.updateOne({ booking: booking._id }, { $set: { lifecycle: 'change_pending' } });
      await action(
        booking,
        admin,
        { action: 'photographer.assign', photographerId: String(other._id) },
        409,
      );
    },
  );

  await t.test(
    'concurrent confirmations have a single winner and recheck provisional assignments',
    async () => {
      const first = await makeBooking('20');
      const second = await makeBooking('20');
      await ready(first, a);
      await ready(second, a);
      const requests = await Promise.all(
        [first, second].map(async (booking) => {
          const wf = await Workflow.findOne({ booking: booking._id }).lean();
          return call(
            `/bookings/${booking._id}/workflow/actions`,
            admin,
            {
              expectedVersion: wf.version,
              action: 'resources.confirm',
              schedule: { ...wf.quote.proposedSchedule, photographerIds: [String(a._id)] },
            },
            'POST',
            { 'Idempotency-Key': `confirm-race-${booking._id}` },
          );
        }),
      );
      assert.deepEqual(requests.map((r) => r.status).sort(), [200, 409], JSON.stringify(requests));
      assert.equal(
        await Schedule.countDocuments({ shootDate: new Date('2027-01-20T00:00:00+07:00') }),
        1,
      );
    },
  );

  await t.test(
    'busy time and legacy schedule creation serialize on the same resource lock',
    async () => {
      const customer = await Customer.create({
        className: 'Test',
        total: 1,
        createdBy: admin._id,
        contactName: 'Test',
        contactPhone: '0901234567',
        contactAddress: 'Studio',
      });
      const results = await Promise.all([
        call('/photographers/unavailability', a, {
          startAt: '2027-01-22T08:00:00+07:00',
          endAt: '2027-01-22T11:00:00+07:00',
        }),
        call('/schedules', admin, {
          customer: String(customer._id),
          shootDate: '2027-01-22T00:00:00+07:00',
          startTime: '08:00',
          endTime: '11:00',
          leadPhotographer: String(a._id),
          status: 'confirmed',
        }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], JSON.stringify(results));
    },
  );

  await t.test('personal busy time and workflow confirmation cannot both win', async () => {
    const booking = await makeBooking('24');
    await ready(booking, a);
    const workflow = await Workflow.findOne({ booking: booking._id }).lean();
    const results = await Promise.all([
      call('/photographers/unavailability', a, {
        startAt: booking.startAt.toISOString(),
        endAt: booking.endAt.toISOString(),
      }),
      call(
        `/bookings/${booking._id}/workflow/actions`,
        admin,
        {
          expectedVersion: workflow.version,
          action: 'resources.confirm',
          schedule: { ...workflow.quote.proposedSchedule, photographerIds: [String(a._id)] },
        },
        'POST',
        { 'Idempotency-Key': 'workflow-block-race-001' },
      ),
    ]);
    assert.equal(results.filter((r) => r.status < 300).length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.status === 409).length, 1, JSON.stringify(results));
  });

  await t.test('failed reassignment retains the original lead, access and version', async () => {
    const booking = await makeBooking('26');
    await ready(booking, a);
    const dto = await confirm(booking, a);
    await manual('26', '08:00', '11:00', b);
    await action(
      booking,
      admin,
      { action: 'photographer.assign', photographerId: String(b._id) },
      409,
    );
    const after = await Workflow.findOne({ booking: booking._id }).lean();
    assert.equal(after.version, dto.workflow.version);
    assert.equal(String(after.assignedPhotographer), String(a._id));
    assert.equal(
      String((await Schedule.findById(dto.workflow.resources.scheduleId)).leadPhotographer),
      String(a._id),
    );
    assert.equal((await call(`/bookings/${booking._id}/workflow`, a)).status, 200);
    assert.equal((await call(`/bookings/${booking._id}/workflow`, b)).status, 404);
    assert.equal((await call(`/schedules/${dto.workflow.resources.scheduleId}`, b)).status, 404);
    const mine = await call('/schedules', b);
    assert.ok(mine.body.data.every((row) => row._id !== dto.workflow.resources.scheduleId));
    const proposed = (await call(`/bookings/${booking._id}/workflow`, a)).body.data.workflow;
    assert.equal(proposed.quote, null);
    assert.equal(proposed.proposedSchedule.startTime, '08:00');
  });

  await t.test(
    'multi-person drafts persist, grant scoped access, and synchronize all crew when confirmed or changed',
    async () => {
      const booking = await makeBooking('28');
      const crew = [String(a._id), String(b._id)];
      const draft = await action(booking, admin, {
        action: 'photographer.assign',
        photographerIds: crew,
      });
      assert.equal(draft.workflow.assignedPhotographer._id, crew[0]);
      assert.deepEqual(
        draft.workflow.assignedSupportPhotographers.map((row) => row._id),
        [crew[1]],
      );
      assert.equal(await Schedule.countDocuments({ workflowBooking: booking._id }), 0);
      assert.equal(
        (await call(`/bookings/${booking._id}/workflow`, b)).body.data.booking.phone,
        booking.phone,
      );
      assert.ok(
        (await call('/workflows', b)).body.data.some(
          (row) => row.bookingId === String(booking._id),
        ),
      );
      await action(booking, b, { action: 'progress.update', status: 'shooting' }, 403);
      for (const photographerIds of [
        [],
        [crew[0], crew[0]],
        [crew[0], String(inactive._id)],
        'bad',
        Array(11).fill(crew[0]),
      ]) {
        await action(booking, admin, { action: 'photographer.assign', photographerIds }, 400);
      }
      await action(booking, admin, { action: 'photographer.assign', photographerIds: [crew[0]] });
      assert.equal((await call(`/bookings/${booking._id}/workflow`, b)).status, 404);
      assert.ok(
        !(await call('/workflows', b)).body.data.some(
          (row) => row.bookingId === String(booking._id),
        ),
      );
      await action(booking, admin, { action: 'photographer.assign', photographerIds: crew });
      await ready(booking, a);
      const dto = await confirm(booking, a, [b]);
      let schedule = await Schedule.findById(dto.workflow.resources.scheduleId);
      assert.deepEqual(schedule.supportPhotographers.map(String), [String(b._id)]);
      const busySchedule = await manual('28', '08:00', '11:00', other);
      await action(
        booking,
        admin,
        { action: 'photographer.assign', photographerIds: [String(a._id), String(other._id)] },
        409,
      );
      schedule = await Schedule.findById(dto.workflow.resources.scheduleId);
      assert.deepEqual(schedule.supportPhotographers.map(String), [String(b._id)]);
      await Schedule.deleteOne({ _id: busySchedule._id });
      await action(booking, admin, {
        action: 'photographer.assign',
        photographerIds: [String(b._id), String(other._id)],
      });
      schedule = await Schedule.findById(dto.workflow.resources.scheduleId);
      assert.equal(String(schedule.leadPhotographer), String(b._id));
      assert.deepEqual(schedule.supportPhotographers.map(String), [String(other._id)]);
      assert.equal((await call(`/bookings/${booking._id}/workflow`, a)).status, 404);
      assert.equal((await call(`/bookings/${booking._id}/workflow`, other)).status, 200);
      await action(booking, admin, {
        action: 'photographer.assign',
        photographerIds: [String(b._id)],
      });
      assert.equal((await call(`/bookings/${booking._id}/workflow`, other)).status, 404);
    },
  );

  await t.test(
    'two crews sharing a support photographer cannot reserve the same interval',
    async () => {
      const first = await makeBooking('30');
      const second = await makeBooking('30');
      await ready(first, a);
      await ready(second, b);
      const results = await Promise.all(
        [
          [first, a],
          [second, b],
        ].map(async ([booking, lead]) => {
          const workflow = await Workflow.findOne({ booking: booking._id }).lean();
          return call(
            `/bookings/${booking._id}/workflow/actions`,
            admin,
            {
              expectedVersion: workflow.version,
              action: 'resources.confirm',
              schedule: {
                ...workflow.quote.proposedSchedule,
                photographerIds: [String(lead._id), String(other._id)],
              },
            },
            'POST',
            { 'Idempotency-Key': `support-race-${booking._id}` },
          );
        }),
      );
      assert.deepEqual(
        results.map((row) => row.status).sort(),
        [200, 409],
        JSON.stringify(results),
      );
    },
  );
});
