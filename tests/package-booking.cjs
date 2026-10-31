// All writes are isolated in studio_package_booking_test on localhost.
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'package-booking-tests-only';
process.env.CLIENT_PORTAL_ENABLED = 'true';
process.env.CLIENT_WORKFLOW_ENABLED = 'true';
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const Package = require('../src/models/Package').default;
const Booking = require('../src/models/Booking').default;
const Workflow = require('../src/models/BookingWorkflow').default;
const User = require('../src/models/User').default;
const Schedule = require('../src/models/Schedule').default;
const Costume = require('../src/models/Costume').default;
const CostumeType = require('../src/models/CostumeType').default;
const Student = require('../src/models/Student').default;
const Transaction = require('../src/models/Transaction').default;
const { readPackageAgreement } = require('../src/services/packageBooking');
const { expirePackageReservations } = require('../src/services/bookingExpiry');
const { photographerAvailability } = require('../src/services/photographerAvailability');
const DATABASE = 'studio_package_booking_test';

test('package agreement validates consent, immutable pricing, contact-only and same-day bookings', () => {
  const pkg = {
    pricePerMember: 500000,
    depositPercent: 30,
    depositHoldHours: 24,
    detailsVersion: 0,
  };
  const agreement = {
    accepted: true,
    pricePerMember: 500000,
    depositPercent: 30,
    holdHours: 24,
    detailsVersion: 0,
  };
  const start = new Date('2099-11-01T08:00:00+07:00'),
    end = new Date('2099-11-01T12:00:00+07:00');
  const result = readPackageAgreement(agreement, pkg, 2, start, end);
  assert.equal(result.total, 1000000);
  assert.equal(result.depositRequired, 300000);
  for (const input of [
    { ...agreement, accepted: false },
    { ...agreement, pricePerMember: 1 },
    { ...agreement, depositPercent: 50 },
    { ...agreement, detailsVersion: 1 },
  ])
    assert.throws(() => readPackageAgreement(input, pkg, 2, start, end));
  assert.throws(() =>
    readPackageAgreement(agreement, { ...pkg, pricePerMember: 0 }, 2, start, end),
  );
  assert.throws(() =>
    readPackageAgreement(agreement, pkg, 2, start, new Date('2099-11-02T12:00:00+07:00')),
  );
});

test('package checkout, temporary crew holds, automatic confirmation, roster and expiry refunds', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname));
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
  const [admin, client, accountant, photographer, backup] = await User.create(
    [
      ['admin', 0],
      ['client', 6],
      ['accountant', 5],
      ['photo', 3],
      ['backup', 3],
    ].map(([name, role]) => ({
      username: `package.${name}`,
      name,
      roles: [role],
      password: 'PackageTest123!',
      isActive: true,
    })),
  );
  const costumeType = await CostumeType.create({ name: 'Trang phục gói test' });
  const costume = await Costume.create({
    name: 'Áo dài test',
    type: costumeType._id,
    inventory: [{ size: 'M', quantity: 2, condition: 'good' }],
  });
  const pkg = await Package.create({
    name: 'Gói tiêu chuẩn test',
    pricePerMember: 500000,
    deliveryDays: 7,
    studentsPerCrew: 15,
    costumes: [costumeType._id],
  });
  const app = express();
  app.use(express.json());
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use('/photographers', require('../src/routes/photographerAvailability').default);
  app.use('/public', require('../src/routes/public').default);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  const call = async (url, actor = client, body, method = body ? 'POST' : 'GET', key) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(actor
          ? {
              Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET)}`,
            }
          : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const make = async (date, actor = client, members = 2) => {
    const current = await Package.findById(pkg._id).lean();
    const response = await call(
      '/bookings',
      actor,
      {
        packageId: String(pkg._id),
        members,
        contactName: 'Khách test',
        phone: '0901234567',
        startAt: `${date}T08:00:00+07:00`,
        endAt: `${date}T12:00:00+07:00`,
        location: 'Sân trường test',
        packageAgreement: {
          accepted: true,
          pricePerMember: current.pricePerMember,
          depositPercent: current.depositPercent,
          holdHours: current.depositHoldHours,
          detailsVersion: current.detailsVersion,
          updatedAt: current.updatedAt.toISOString(),
        },
      },
      'POST',
      `package-create-${++sequence}`,
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data._id;
  };
  const action = async (id, actor, body, expected = 200, key) => {
    const workflow = await Workflow.findOne({ booking: id }).lean();
    const response = await call(
      `/bookings/${id}/workflow/actions`,
      actor,
      { expectedVersion: workflow?.version ?? 0, ...body },
      'POST',
      key || `package-action-${++sequence}`,
    );
    assert.equal(response.status, expected, JSON.stringify(response.body));
    return response.body.data;
  };
  const approve = (id) =>
    call(
      `/bookings/${id}/review`,
      admin,
      { status: 'approved', note: 'Đã kiểm tra gói và ekip.' },
      'PATCH',
    );
  let first;
  await t.test(
    'approval snapshots the accepted price, holds crew and blocks conflicting bookings/private blocks',
    async () => {
      first = await make('2099-11-01');
      await Package.updateOne({ _id: pkg._id }, { $set: { pricePerMember: 700000 } });
      await action(first, admin, {
        action: 'photographer.assign',
        photographerId: String(photographer._id),
      });
      assert.equal((await approve(first)).status, 200);
      const workflow = await Workflow.findOne({ booking: first }).lean();
      assert.equal(workflow.quote.lines[0].unitPrice, 500000);
      assert.equal(workflow.quote.depositRequired, 300000);
      assert.equal(workflow.packageReservation.status, 'held');
      assert.ok(workflow.packageReservation.expiresAt.getTime() > Date.now() + 23 * 3600000);
      assert.equal(await Schedule.countDocuments({ workflowBooking: first }), 0);
      const conflict = await make('2099-11-01');
      await action(
        conflict,
        admin,
        { action: 'photographer.assign', photographerId: String(photographer._id) },
        409,
      );
      const block = await call('/photographers/unavailability', photographer, {
        startAt: '2099-11-01T09:00:00+07:00',
        endAt: '2099-11-01T10:00:00+07:00',
        note: 'Busy',
      });
      assert.equal(block.status, 409);
      await action(first, admin, { action: 'quote.propose', quote: {} }, 409);
    },
  );
  await t.test(
    'partial and duplicate payments preserve one transaction; sufficient deposit creates one schedule without a roster',
    async () => {
      const partial = { action: 'payment.record', kind: 'deposit', amount: 100000, method: 'cash' };
      await action(first, accountant, partial, 200, 'package-partial-idempotent');
      await action(first, accountant, partial, 200, 'package-partial-idempotent');
      assert.equal(await Transaction.countDocuments({ workflowBooking: first }), 1);
      assert.equal(await Schedule.countDocuments({ workflowBooking: first }), 0);
      await action(
        first,
        accountant,
        { action: 'payment.record', kind: 'deposit', amount: 200000, method: 'cash' },
        200,
        'package-final-idempotent',
      );
      await action(
        first,
        accountant,
        { action: 'payment.record', kind: 'deposit', amount: 200000, method: 'cash' },
        200,
        'package-final-idempotent',
      );
      const workflow = await Workflow.findOne({ booking: first }).lean();
      assert.equal(workflow.lifecycle, 'confirmed');
      assert.equal(workflow.packageReservation.status, 'confirmed');
      assert.equal(workflow.members.length, 0);
      assert.equal(await Schedule.countDocuments({ workflowBooking: first }), 1);
      assert.equal(await Transaction.countDocuments({ workflowBooking: first }), 2);
      const schedule = await Schedule.findOne({ workflowBooking: first }).lean();
      assert.equal(schedule.startTime, '08:00');
      assert.equal(schedule.endTime, '12:00');
      await action(first, admin, { action: 'progress.update', status: 'shooting' }, 409);
    },
  );
  await t.test(
    'admin prepares included costumes after automatic confirmation with stock and role checks',
    async () => {
      const costumes = [
        {
          costumeId: String(costume._id),
          size: 'M',
          quantity: 2,
          receiveDate: '2099-11-01',
          returnDate: '2099-11-01',
        },
      ];
      await action(first, client, { action: 'resources.costumes', costumes }, 403);
      await action(first, admin, { action: 'resources.costumes', costumes });
      let schedule = await Schedule.findOne({ workflowBooking: first }).lean();
      assert.equal(schedule.costumeReservations[0].quantity, 2);
      await action(
        first,
        admin,
        { action: 'resources.costumes', costumes: [{ ...costumes[0], quantity: 3 }] },
        409,
      );
      schedule = await Schedule.findOne({ workflowBooking: first }).lean();
      assert.equal(schedule.costumeReservations[0].quantity, 2);
      assert.equal(schedule.startTime, '08:00');
    },
  );
  await t.test(
    'roster and public member intake work after confirmation and synchronize students without duplicates',
    async () => {
      let workflow = await Workflow.findOne({ booking: first }).lean();
      const roster = await call(
        `/bookings/${first}/workflow/members`,
        client,
        {
          expectedVersion: workflow.version,
          members: [{ name: 'Bạn A', gender: 'female', costumeSizes: [] }],
        },
        'POST',
        'package-roster-save',
      );
      assert.equal(roster.status, 200, JSON.stringify(roster.body));
      workflow = await Workflow.findOne({ booking: first }).lean();
      assert.equal(await Student.countDocuments({ customer: workflow.customer }), 1);
      const data = await action(first, client, { action: 'member-link.open' });
      const intake = await call(`/public/member-intake/${data.workflow.memberEntry.token}`, null, {
        requestId: 'package-member-b',
        name: 'Bạn B',
        gender: 'male',
        costumeSizes: [],
      });
      assert.equal(intake.status, 201, JSON.stringify(intake.body));
      assert.equal(await Student.countDocuments({ customer: workflow.customer }), 2);
      await action(first, admin, { action: 'progress.update', status: 'shooting' });
      assert.equal((await Workflow.findOne({ booking: first }).lean()).lifecycle, 'shooting');
    },
  );
  await t.test(
    'expired holds release immediately and preserve partial money as refundable',
    async () => {
      const id = await make('2099-11-03');
      await action(id, admin, {
        action: 'photographer.assign',
        photographerId: String(backup._id),
      });
      assert.equal((await approve(id)).status, 200);
      await action(id, accountant, {
        action: 'payment.record',
        kind: 'deposit',
        amount: 10000,
        method: 'cash',
      });
      await Workflow.updateOne(
        { booking: id },
        { $set: { 'packageReservation.expiresAt': new Date(Date.now() - 1000) } },
      );
      const available = await photographerAvailability(
        {
          start: Date.parse('2099-11-03T08:00:00+07:00'),
          end: Date.parse('2099-11-03T12:00:00+07:00'),
        },
        { photographerIds: [String(backup._id)] },
      );
      assert.equal(available[0].status, 'available');
      assert.equal(await expirePackageReservations(), 1);
      const detail = await call(`/bookings/${id}/workflow`);
      assert.equal(detail.body.data.booking.status, 'cancelled');
      assert.equal(detail.body.data.workflow.payments.refundDue, 10000);
      assert.equal(detail.body.data.workflow.payments.totalDue, 0);
      await action(id, accountant, {
        action: 'payment.record',
        kind: 'refund',
        amount: 10000,
        method: 'cash',
      });
      assert.equal(await Schedule.countDocuments({ workflowBooking: id }), 0);
      const after = await call(`/bookings/${id}/workflow`);
      assert.equal(after.body.data.workflow.payments.netReceived, 0);
    },
  );
  await t.test(
    'two approvals with the same preassigned team cannot both reserve the slot',
    async () => {
      const a = await make('2099-11-05'),
        b = await make('2099-11-05');
      for (const id of [a, b])
        await action(id, admin, {
          action: 'photographer.assign',
          photographerId: String(photographer._id),
        });
      const responses = await Promise.all([approve(a), approve(b)]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    },
  );
  await t.test(
    'accepted price changes confirm a held package when the partial deposit is now sufficient',
    async () => {
      const id = await make('2099-11-07');
      await action(id, admin, {
        action: 'photographer.assign',
        photographerId: String(backup._id),
      });
      assert.equal((await approve(id)).status, 200);
      await action(id, accountant, {
        action: 'payment.record',
        kind: 'deposit',
        amount: 100000,
        method: 'cash',
      });
      await action(id, client, {
        action: 'change.request',
        kind: 'change',
        note: 'Điều chỉnh phạm vi',
      });
      const wf = await Workflow.findOne({ booking: id }).lean();
      const requestId = String(wf.changeRequest._id);
      await action(id, admin, {
        action: 'change.propose',
        requestId,
        finalPayable: 100000,
        proposed: { schedule: wf.quote.proposedSchedule },
        terms: ['Giảm phạm vi theo thỏa thuận'],
      });
      await action(id, client, { action: 'change.accept', requestId });
      const confirmed = await Workflow.findOne({ booking: id }).lean();
      assert.equal(confirmed.lifecycle, 'confirmed');
      assert.equal(await Schedule.countDocuments({ workflowBooking: id }), 1);
    },
  );
  await t.test(
    'package crew capacity is enforced on approval and subsequent reassignment',
    async () => {
      const id = await make('2099-11-09', client, 16);
      await action(id, admin, {
        action: 'photographer.assign',
        photographerId: String(photographer._id),
      });
      assert.equal((await approve(id)).status, 409);
      await action(id, admin, {
        action: 'photographer.assign',
        photographerIds: [String(photographer._id), String(backup._id)],
      });
      assert.equal((await approve(id)).status, 200);
      await action(
        id,
        admin,
        { action: 'photographer.assign', photographerIds: [String(photographer._id)] },
        409,
      );
      const wf = await Workflow.findOne({ booking: id }).lean();
      assert.equal(wf.packageReservation.photographers.length, 2);
    },
  );
});
