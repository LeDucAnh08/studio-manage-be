// Real HTTP + MongoDB transactions, restricted to a separate payment test database.
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac } = require('node:crypto');
process.env.TS_NODE_PROJECT = path.resolve(__dirname, '../tsconfig.json');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
Object.assign(process.env, {
  JWT_SECRET: 'sepay-http-tests-only',
  CLIENT_PORTAL_ENABLED: 'true',
  CLIENT_WORKFLOW_ENABLED: 'true',
  SEPAY_ENABLED: 'true',
  SEPAY_MODE: 'sandbox',
  SEPAY_SANDBOX_DATABASE: 'studio_sepay_webhook_test',
  SEPAY_WEBHOOK_SECRET: 'sandbox-test-signing-secret-32-characters-minimum',
  PAYMENT_BANK_CODE: 'MBBank',
  SEPAY_BANK_GATEWAY: 'MBBank',
  PAYMENT_BANK_NAME: 'MBBank',
  PAYMENT_ACCOUNT_NAME: 'STUDIO SANDBOX',
  PAYMENT_ACCOUNT_NUMBER: 'SBSTUDIO001',
});
require('ts-node/register/transpile-only');
const mongoose = require('mongoose'),
  express = require('express'),
  jwt = require('jsonwebtoken');
const model = (name) => require(`../src/models/${name}`).default;
const Booking = model('Booking'),
  Workflow = model('BookingWorkflow'),
  Receipt = model('SePayReceipt');
const User = model('User'),
  Package = model('Package'),
  Schedule = model('Schedule'),
  Transaction = model('Transaction');
const { processSePayReceipt, parseSePayPayload } = require('../src/services/sepay');
const { expirePackageReservations } = require('../src/services/bookingExpiry');
const { sepayConfig } = require('../src/services/depositPayment');

test('automatic SePay package deposits authenticate, deduplicate and confirm atomically', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname));
  uri.pathname = '/studio_sepay_webhook_test';
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, 'studio_sepay_webhook_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([
    Receipt.createIndexes(),
    Workflow.createIndexes(),
    Booking.createIndexes(),
    Schedule.createIndexes(),
  ]);
  const [admin, accountant, client, photographer] = await User.create(
    [0, 5, 6, 3].map((role) => ({
      username: `sepay.role${role}`,
      password: 'SePayTest123!',
      name: `Actor ${role}`,
      roles: [role],
      isActive: true,
    })),
  );
  const pkg = await Package.create({
    name: 'Gói QR thử nghiệm',
    pricePerMember: 500000,
    studentsPerCrew: 15,
    deliveryDays: 5,
    costumes: [],
  });
  const app = express();
  app.use('/payments', require('../src/routes/payments').default);
  app.use(express.json());
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use((err, req, res, next) => res.status(500).json({ message: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(mongoose.connection.name, 'studio_sepay_webhook_test');
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0,
    txId = 1000;
  const call = async (url, actor = client, body, key) => {
    const response = await fetch(base + url, {
      method: url.endsWith('/review') ? 'PATCH' : body ? 'POST' : 'GET',
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
  const action = async (id, actor, body, key) => {
    const w = await Workflow.findOne({ booking: id }).lean();
    return call(
      `/bookings/${id}/workflow/actions`,
      actor,
      { expectedVersion: w?.version ?? 0, ...body },
      key || `sepay-action-${++sequence}`,
    );
  };
  const make = async (approve = true) => {
    const day = new Date(Date.UTC(2099, 10, ++sequence)).toISOString().slice(0, 10);
    const res = await call(
      '/bookings',
      client,
      {
        packageId: String(pkg._id),
        members: 2,
        className: `QR ${sequence}`,
        phone: '0901234567',
        contactName: 'Khách QR',
        startAt: `${day}T08:00:00+07:00`,
        endAt: `${day}T12:00:00+07:00`,
        location: 'Studio test',
        note: '',
        students: [
          { name: 'Bạn A', phone: '0901234567', pantsSize: '28', shirtSize: 'M' },
          { name: 'Bạn B', phone: '0901234568', pantsSize: '29', shirtSize: 'M' },
        ],
        packageAgreement: {
          accepted: true,
          pricePerMember: 500000,
          depositPercent: 30,
          holdHours: 24,
          detailsVersion: 0,
          updatedAt: pkg.updatedAt.toISOString(),
        },
      },
      `sepay-create-${sequence}`,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.data._id;
    assert.equal(
      (
        await action(id, admin, {
          action: 'photographer.assign',
          photographerId: String(photographer._id),
        })
      ).status,
      200,
    );
    if (approve) {
      const approved = await call(`/bookings/${id}/review`, admin, {
        status: 'approved',
        note: 'Duyệt QR',
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
    }
    return id;
  };
  const detail = async (id) => {
    const response = await call(`/bookings/${id}/workflow`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data;
  };
  const payload = (reference, amount = 300000, patch = {}) => ({
    id: ++txId,
    gateway: 'MBBank',
    accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER,
    code: reference,
    content: `chuyen tien ${reference}`,
    transferType: 'in',
    transferAmount: amount,
    transactionDate: new Date(Date.now() + 7 * 3600000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' '),
    referenceCode: `BANK-${txId}`,
    ...patch,
  });
  const deliver = async (
    data,
    { timestamp = String(Math.floor(Date.now() / 1000)), signature, body } = {},
  ) => {
    body = body || JSON.stringify(data, null, 2);
    signature =
      signature ||
      `sha256=${createHmac('sha256', process.env.SEPAY_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
    const response = await fetch(base + '/payments/sepay/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SePay-Signature': signature,
        'X-SePay-Timestamp': timestamp,
      },
      body,
    });
    return { status: response.status, body: await response.json() };
  };

  let first, firstReference;
  await t.test(
    'missing configuration rolls approval back; approved QR snapshots agreed money and repeat approval retains reference',
    async () => {
      first = await make(false);
      const saved = process.env.PAYMENT_ACCOUNT_NAME;
      process.env.PAYMENT_ACCOUNT_NAME = '';
      assert.equal(
        (await call(`/bookings/${first}/review`, admin, { status: 'approved', note: 'Duyệt QR' }))
          .status,
        503,
      );
      assert.equal((await Booking.findById(first)).status, 'pending');
      assert.equal((await Workflow.findOne({ booking: first })).packageReservation, undefined);
      process.env.PAYMENT_ACCOUNT_NAME = saved;
      assert.equal(
        (await call(`/bookings/${first}/review`, admin, { status: 'approved', note: 'Duyệt QR' }))
          .status,
        200,
      );
      const before = await detail(first);
      firstReference = before.workflow.depositPayment.reference;
      assert.equal(before.workflow.depositPayment.amount, 300000);
      const qr = new URL(before.workflow.depositPayment.qrUrl);
      assert.equal(qr.searchParams.get('amount'), '300000');
      assert.equal(qr.searchParams.get('des'), firstReference);
      assert.equal(qr.searchParams.get('acc'), process.env.PAYMENT_ACCOUNT_NUMBER);
      assert.equal(
        (await call(`/bookings/${first}/review`, admin, { status: 'approved', note: 'Duyệt QR' }))
          .status,
        200,
      );
      assert.equal((await detail(first)).workflow.depositPayment.reference, firstReference);
    },
  );
  await t.test(
    'signature uses raw bytes; forged, old signatures and invalid calendars create no receipt',
    async () => {
      const event = payload(firstReference);
      const before = await Receipt.countDocuments();
      assert.equal((await deliver(event, { signature: 'sha256=' + '0'.repeat(64) })).status, 401);
      assert.equal(
        (await deliver(event, { timestamp: String(Math.floor(Date.now() / 1000) - 1000) })).status,
        401,
      );
      assert.equal(
        (await deliver({ ...event, transactionDate: '2026-02-30 10:00:00' })).status,
        400,
      );
      assert.equal((await deliver({ ...event, transferAmount: 1.5 })).status, 400);
      assert.equal((await deliver({ ...event, transferType: ['in'] })).status, 400);
      assert.equal((await deliver({ ...event, gateway: '***' })).status, 400);
      assert.equal(await Receipt.countDocuments(), before);
      assert.equal(
        parseSePayPayload({
          ...event,
          transactionDate: '2026-11-05 08:00:00',
        }).transactionDate.toISOString(),
        '2026-11-05T01:00:00.000Z',
      );
    },
  );
  await t.test(
    'partial payments accumulate; concurrent delivery and different webhook IDs with the same bank reference never duplicate money',
    async () => {
      const event = payload(firstReference, 100000);
      const results = await Promise.all([
        deliver(event),
        deliver(event),
        deliver({ ...event, id: ++txId }),
      ]);
      results.forEach((result) => assert.equal(result.status, 200, JSON.stringify(result.body)));
      assert.equal(await Transaction.countDocuments({ workflowBooking: first }), 1);
      assert.equal((await detail(first)).workflow.depositPayment.amount, 200000);
      assert.equal((await detail(first)).workflow.lifecycle, 'awaiting_deposit');
      const final = payload(firstReference, 200000);
      const finish = await Promise.all([deliver(final), deliver(final)]);
      finish.forEach((result) => assert.equal(result.status, 200, JSON.stringify(result.body)));
      assert.equal(await Schedule.countDocuments({ workflowBooking: first }), 1);
      assert.equal(await Transaction.countDocuments({ workflowBooking: first }), 2);
      const w = await Workflow.findOne({ booking: first });
      assert.equal(w.lifecycle, 'confirmed');
      assert.ok(w.payments.every((p) => p.source === 'sepay' && !p.recordedBy));
      const txs = await Transaction.find({ workflowBooking: first });
      assert.ok(txs.every((tx) => tx.paymentSource === 'sepay' && !tx.createdBy));
      const paid = (await detail(first)).workflow.depositPayment;
      assert.equal(paid.status, 'paid');
      assert.equal(paid.qrUrl, null);
    },
  );
  await t.test(
    'overpayments, wrong accounts, unknown references and outgoing transfers are retained without credit',
    async () => {
      const id = await make(),
        reference = (await detail(id)).workflow.depositPayment.reference;
      for (const event of [
        payload(reference, 400000),
        payload(reference, 100000, { accountNumber: 'WRONG12345' }),
        payload(reference, 100000, { gateway: 'AnotherBank' }),
        payload('YUMEAAAAAAAAAAAAAAAA'),
        payload(reference, 1000, { transferType: 'out' }),
      ]) {
        assert.equal((await deliver(event)).status, 200);
        const stored = await Receipt.findOne({ providerTransactionId: String(event.id) });
        assert.ok(['review', 'ignored'].includes(stored.status));
        assert.ok(stored.reason);
      }
      assert.equal(await Transaction.countDocuments({ workflowBooking: id }), 0);
      assert.equal(await Schedule.countDocuments({ workflowBooking: id }), 0);
    },
  );
  await t.test(
    'current shortened deadline and expired/cancelled holds cannot be resurrected',
    async () => {
      const id = await make(),
        ref = (await detail(id)).workflow.depositPayment.reference;
      await Workflow.updateOne(
        { booking: id },
        { $set: { 'packageReservation.expiresAt': new Date(Date.now() - 1000) } },
      );
      await expirePackageReservations();
      assert.equal((await deliver(payload(ref))).status, 200);
      assert.equal((await Booking.findById(id)).status, 'cancelled');
      assert.equal(await Schedule.countDocuments({ workflowBooking: id }), 0);
      assert.equal(await Transaction.countDocuments({ workflowBooking: id }), 0);
      const cancelled = await make(),
        cancelledRef = (await detail(cancelled)).workflow.depositPayment.reference;
      await Booking.updateOne({ _id: cancelled }, { $set: { status: 'cancelled' } });
      assert.equal((await deliver(payload(cancelledRef))).status, 200);
      assert.equal(await Schedule.countDocuments({ workflowBooking: cancelled }), 0);
    },
  );
  await t.test(
    'resource failure preserves money evidence for review; a pending receipt survives a crash before application',
    async () => {
      const id = await make(),
        ref = (await detail(id)).workflow.depositPayment.reference;
      await User.updateOne({ _id: photographer._id }, { $set: { isActive: false } });
      const event = payload(ref);
      assert.equal((await deliver(event)).status, 200);
      const review = await Receipt.findOne({ providerTransactionId: String(event.id) });
      assert.equal(review.status, 'review');
      assert.ok(review.reason);
      assert.equal(await Transaction.countDocuments({ workflowBooking: id }), 0);
      await User.updateOne({ _id: photographer._id }, { $set: { isActive: true } });
      const pendingId = await make(),
        pendingRef = (await detail(pendingId)).workflow.depositPayment.reference;
      const normalized = parseSePayPayload(payload(pendingRef));
      const receipt = await Receipt.create({
        ...normalized,
        mode: 'sandbox',
        payloadHash: 'durably-ingested-test',
        status: 'pending',
      });
      await processSePayReceipt(receipt._id);
      await processSePayReceipt(receipt._id);
      assert.equal((await Receipt.findById(receipt._id)).status, 'applied');
      assert.equal(await Schedule.countDocuments({ workflowBooking: pendingId }), 1);
    },
  );
  await t.test(
    'manual bank deposit cannot race a provider receipt, while manual cash uses the same payment rules',
    async () => {
      const id = await make(),
        ref = (await detail(id)).workflow.depositPayment.reference;
      const results = await Promise.all([
        action(id, accountant, {
          action: 'payment.record',
          kind: 'deposit',
          amount: 100000,
          method: 'bank_transfer',
        }),
        deliver(payload(ref, 100000)),
      ]);
      assert.equal(results[0].status, 409);
      assert.equal(results[1].status, 200);
      assert.equal(await Transaction.countDocuments({ workflowBooking: id }), 1);
      const cash = await action(id, accountant, {
        action: 'payment.record',
        kind: 'deposit',
        amount: 200000,
        method: 'cash',
      });
      assert.equal(cash.status, 200, JSON.stringify(cash.body));
      assert.equal(await Schedule.countDocuments({ workflowBooking: id }), 1);
    },
  );
  await t.test(
    'exception list is available only to admin/accountant and sandbox cannot be enabled against the operating database',
    async () => {
      assert.equal((await call('/payments/sepay/receipts', client)).status, 403);
      assert.equal((await call('/payments/sepay/receipts', photographer)).status, 403);
      const list = await call('/payments/sepay/receipts', accountant);
      assert.equal(list.status, 200);
      assert.ok(list.body.data.length > 0);
      assert.ok(list.body.data.every((row) => !row.payloadHash));
      const sandbox = process.env.SEPAY_SANDBOX_DATABASE;
      process.env.SEPAY_SANDBOX_DATABASE = 'studio_db';
      assert.throws(() => sepayConfig(), /database riêng/);
      process.env.SEPAY_SANDBOX_DATABASE = sandbox;
      process.env.SEPAY_MODE = 'live';
      assert.throws(() => sepayConfig(), /tiền thật/);
      process.env.SEPAY_MODE = 'sandbox';
    },
  );
  await t.test(
    'database failures preserve pending intake for provider retry without duplicating money',
    async () => {
      const id = await make(),
        ref = (await detail(id)).workflow.depositPayment.reference;
      const event = payload(ref);
      const original = Transaction.create;
      Transaction.create = async () => {
        throw new Error('simulated temporary database failure');
      };
      try {
        assert.equal((await deliver(event)).status, 500);
      } finally {
        Transaction.create = original;
      }
      assert.equal(
        (await Receipt.findOne({ providerTransactionId: String(event.id) })).status,
        'pending',
      );
      assert.equal(await Schedule.countDocuments({ workflowBooking: id }), 0);
      assert.equal((await deliver(event)).status, 200);
      assert.equal(await Schedule.countDocuments({ workflowBooking: id }), 1);
      assert.equal(await Transaction.countDocuments({ workflowBooking: id }), 1);
    },
  );
  await t.test(
    'account rotation suppresses obsolete QR and conflicting signed retries retain evidence without extra credit',
    async () => {
      const id = await make(),
        ref = (await detail(id)).workflow.depositPayment.reference;
      const account = process.env.PAYMENT_ACCOUNT_NUMBER;
      process.env.PAYMENT_ACCOUNT_NUMBER = 'SBROTATED001';
      const hidden = (await detail(id)).workflow.depositPayment;
      assert.equal(hidden.status, 'unavailable');
      assert.equal(hidden.qrUrl, null);
      process.env.PAYMENT_ACCOUNT_NUMBER = account;
      const event = payload(ref, 100000);
      assert.equal((await deliver(event)).status, 200);
      const conflict = { ...event, transferAmount: 200000 };
      assert.equal((await deliver(conflict)).status, 200);
      assert.equal((await deliver(conflict)).status, 200);
      const receipt = await Receipt.findOne({ providerTransactionId: String(event.id) });
      assert.equal(receipt.status, 'applied');
      assert.equal(receipt.hasConflict, true);
      assert.equal(receipt.conflicts.length, 1);
      assert.equal(await Transaction.countDocuments({ workflowBooking: id }), 1);
      assert.equal((await detail(id)).workflow.payments.netReceived, 100000);
      const list = await call('/payments/sepay/receipts', accountant);
      assert.ok(list.body.data.some((row) => row._id === String(receipt._id)));
      assert.equal(receipt.conflicts[0].bankReference, event.referenceCode);
      const bankCode = process.env.PAYMENT_BANK_CODE;
      process.env.PAYMENT_BANK_CODE = '970422';
      const wrongConfig = payload(ref, 100000);
      assert.equal((await deliver(wrongConfig)).status, 200);
      assert.equal(
        (await Receipt.findOne({ providerTransactionId: String(wrongConfig.id) })).status,
        'review',
      );
      assert.equal((await detail(id)).workflow.payments.netReceived, 100000);
      process.env.PAYMENT_BANK_CODE = bankCode;
    },
  );
  await t.test(
    'backfill is explicit, scoped and idempotent and skips paid/expired records',
    async () => {
      const { backfillDepositPayments } = require('../src/services/sepayMaintenance');
      const id = await make();
      await Workflow.updateOne({ booking: id }, { $unset: { depositPayment: 1 } });
      const preview = await backfillDepositPayments({ username: client.username });
      assert.deepEqual(
        preview.map((row) => row.bookingId),
        [id],
      );
      assert.equal((await Workflow.findOne({ booking: id })).depositPayment, undefined);
      assert.equal(
        (await backfillDepositPayments({ username: client.username, apply: true })).length,
        1,
      );
      const reference = (await Workflow.findOne({ booking: id })).depositPayment.reference;
      assert.deepEqual(
        await backfillDepositPayments({ username: client.username, apply: true }),
        [],
      );
      assert.equal((await Workflow.findOne({ booking: id })).depositPayment.reference, reference);
    },
  );
  await t.test(
    'webhook racing an accepted cancellation never creates a schedule or restores a released hold',
    async () => {
      const id = await make(),
        reference = (await detail(id)).workflow.depositPayment.reference;
      const requested = await action(id, client, {
        action: 'change.request',
        kind: 'cancel',
        note: 'Kiểm thử hủy đồng thời với tiền về.',
      });
      assert.equal(requested.status, 200, JSON.stringify(requested.body));
      const requestId = requested.body.data.workflow.changeRequest._id;
      const proposed = await action(id, admin, {
        action: 'change.propose',
        requestId,
        proposed: { finalPayable: 0 },
        terms: ['Hủy miễn phí trong sandbox.'],
      });
      assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
      const results = await Promise.all([
        action(id, client, { action: 'change.accept', requestId }),
        deliver(payload(reference)),
      ]);
      results.forEach((result) => assert.equal(result.status, 200, JSON.stringify(result.body)));
      assert.equal((await Workflow.findOne({ booking: id })).lifecycle, 'cancelled');
      assert.equal(await Transaction.countDocuments({ workflowBooking: id }), 0);
      assert.equal(await Schedule.countDocuments({ workflowBooking: id }), 0);
      assert.equal((await detail(id)).workflow.depositPayment.qrUrl, null);
    },
  );
  await t.test(
    'local demo button also confirms a booking deposit with ownership and idempotency',
    async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      process.env.SEPAY_DEMO_UI = 'true';
      try {
        const id = await make();
        const reference = (await detail(id)).workflow.depositPayment.reference;
        const response = await call(
          '/payments/sepay/sandbox/simulate',
          client,
          { reference },
          'booking-demo-click',
        );
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(
          (
            await call(
              '/payments/sepay/sandbox/simulate',
              client,
              { reference },
              'booking-demo-click',
            )
          ).status,
          200,
        );
        assert.equal((await detail(id)).workflow.depositPayment.status, 'paid');
        assert.equal(await Transaction.countDocuments({ workflowBooking: id }), 1);
      } finally {
        process.env.NODE_ENV = previous;
        delete process.env.SEPAY_DEMO_UI;
      }
    },
  );
});
