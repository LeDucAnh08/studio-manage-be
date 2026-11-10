// Real transactions and signed webhook HTTP on a separate local database. No bank/email requests.
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac } = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
Object.assign(process.env, {
  JWT_SECRET: 'rental-auto-tests-only-secret',
  CLIENT_PORTAL_ENABLED: 'true',
  CLIENT_WORKFLOW_ENABLED: 'true',
  SEPAY_ENABLED: 'true',
  SEPAY_MODE: 'sandbox',
  SEPAY_SANDBOX_DATABASE: 'studio_sepay_rental_auto_test',
  SEPAY_WEBHOOK_SECRET: 'rental-auto-test-webhook-secret-minimum-32',
  PAYMENT_BANK_CODE: 'MBBank',
  SEPAY_BANK_GATEWAY: 'MBBank',
  PAYMENT_BANK_NAME: 'MBBank',
  PAYMENT_ACCOUNT_NAME: 'RENTAL SANDBOX',
  PAYMENT_ACCOUNT_NUMBER: 'SBSTUDIO001',
  EMAIL_ENABLED: 'false',
  RENTAL_MIN_LEAD_HOURS: '0',
  RENTAL_OPEN_HOUR: '0',
  RENTAL_CLOSE_HOUR: '24',
  RENTAL_CLOSED_WEEKDAYS: '',
  NODE_ENV: 'test',
});
require('ts-node/register/transpile-only');
const mongoose = require('mongoose'),
  express = require('express'),
  jwt = require('jsonwebtoken');
const model = (name) => require('../src/models/' + name).default;
const User = model('User'),
  Costume = model('Costume'),
  Rental = model('RentalOrder'),
  Receipt = model('SePayReceipt'),
  Transaction = model('Transaction');
const { rentalPolicy, validateRentalServiceDates } = require('../src/services/rentalPolicy');
const { expireRentalReservations } = require('../src/services/rentalCheckout');
const { getRentalAvailability, loadRentalHolds } = require('../src/services/rentalAvailability');
const { readRentalPeriod } = require('../src/utils/rentalPeriod');

test('automatic rental checkout reserves, expires, reconciles and locks paid orders', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
  uri.pathname = '/studio_sepay_rental_auto_test';
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, 'studio_sepay_rental_auto_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([Rental.createIndexes(), Receipt.createIndexes()]);
  const [admin, finance, client, other] = await User.create(
    [0, 5, 6, 6].map((role, i) => ({
      username: 'rental.auto.' + i,
      name: 'QA actor',
      password: 'RentalTest123!',
      roles: [role],
      isActive: true,
    })),
  );
  const item = await Costume.create({
    name: 'QA áo dài',
    gender: 'unisex',
    isRentalItem: true,
    rentalDailyPrice: 50000,
    rentalSecurityDeposit: 100000,
    inventory: [{ size: 'M', quantity: 1, condition: 'good' }],
  });
  const app = express();
  app.use('/payments', require('../src/routes/payments').default);
  app.use(express.json());
  app.use('/rentals', require('../src/routes/rentals').default);
  app.use('/auth', require('../src/routes/auth').default);
  app.use('/public', require('../src/routes/public').default);
  app.use((error, req, res, next) =>
    res.status(error.status || 500).json({ message: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(mongoose.connection.name, 'studio_sepay_rental_auto_test');
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  let sequence = 0,
    transferId = 1000;
  const call = async (route, actor, body, key) => {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(actor
          ? {
              Authorization:
                'Bearer ' + jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET),
            }
          : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const data = (day = 10) => ({
    contactName: 'QA customer',
    phone: '0901234567',
    receiveDate: `2099-10-${day}`,
    returnDate: `2099-10-${day}`,
    lines: [{ costumeId: String(item._id), size: 'M', quantity: 1 }],
    termsAccepted: true,
    policyVersion: rentalPolicy().version,
  });
  const create = (actor = client, body = data(), key = 'rental-create-' + ++sequence) =>
    call('/rentals', actor, body, key);
  const get = async (id, actor = client) => (await call('/rentals/' + id, actor)).body.data;
  const action = async (id, actor, name, fields = {}) => {
    const order = await get(id, actor);
    return call(
      '/rentals/' + id + '/actions',
      actor,
      { expectedVersion: order.version, action: name, ...fields },
      'rental-action-' + ++sequence,
    );
  };
  const bankTime = () =>
    new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const transfer = async (order, amount, overrides = {}) => {
    const body = {
      id: ++transferId,
      gateway: 'MBBank',
      accountNumber: 'SBSTUDIO001',
      transferType: 'in',
      transferAmount: amount,
      content: order.depositPayment.reference,
      transactionDate: bankTime(),
      referenceCode: 'BANK-' + transferId,
      ...overrides,
    };
    const raw = JSON.stringify(body),
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature =
      'sha256=' +
      createHmac('sha256', process.env.SEPAY_WEBHOOK_SECRET)
        .update(timestamp + '.' + raw)
        .digest('hex');
    const response = await fetch(base + '/payments/sepay/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SePay-Timestamp': timestamp,
        'X-SePay-Signature': signature,
      },
      body: raw,
    });
    assert.equal(response.status, 200, await response.text());
    return {
      payload: body,
      receipt: await Receipt.findOne({ providerTransactionId: String(body.id) }),
    };
  };
  const reset = async () => {
    await Rental.deleteMany({});
    await Receipt.deleteMany({});
    await Transaction.deleteMany({});
  };
  t.beforeEach(reset);

  await t.test(
    'canonical stage filters return matching orders, totals and preserve ownership',
    async () => {
      const { rentalStageStatuses, getRentalStage } = require('../src/services/rentalStages');
      assert.deepEqual(
        Object.values(rentalStageStatuses).flat().sort(),
        [...Rental.schema.path('status').enumValues].sort(),
        'Every workflow status has exactly one stage',
      );
      const source = (await create()).body.data;
      const original = await Rental.findById(source._id).lean();
      await Rental.deleteMany({});
      for (const status of Object.values(rentalStageStatuses).flat()) {
        const copy = {
          ...original,
          _id: new mongoose.Types.ObjectId(),
          status,
          creationKey: 'stage-' + status,
          autoCheckout: false,
        };
        delete copy.depositPayment;
        await Rental.collection.insertOne(copy);
        await Rental.collection.insertOne({
          ...copy,
          _id: new mongoose.Types.ObjectId(),
          client: other._id,
        });
      }
      for (const [stage, statuses] of Object.entries(rentalStageStatuses)) {
        const result = await call('/rentals?view=' + stage, client);
        assert.equal(result.status, 200);
        assert.equal(result.body.pagination.total, statuses.length);
        assert.deepEqual(result.body.data.map((row) => row.status).sort(), [...statuses].sort());
        assert.ok(result.body.data.every((row) => row.orderStage === stage));
        for (const row of result.body.data) {
          assert.equal(getRentalStage(row.status), stage);
          assert.equal((await get(row._id)).orderStage, stage);
          assert.equal((await call('/rentals/' + row._id, other)).status, 404);
        }
        const page = await call('/rentals?view=' + stage + '&limit=1&page=2', client);
        assert.equal(page.body.pagination.total, statuses.length);
        assert.equal(page.body.data.length, statuses.length > 1 ? 1 : 0);
        const staff = await call('/rentals?view=' + stage, admin);
        assert.equal(staff.body.pagination.total, statuses.length * 2);
        assert.ok(staff.body.data.every((row) => row.orderStage === stage));
      }
    },
  );

  await t.test('requires consent, configured price/deposit and service dates', async () => {
    assert.equal((await create(client, { ...data(), termsAccepted: false })).status, 400);
    await Costume.updateOne({ _id: item._id }, { $set: { rentalSecurityDeposit: null } });
    assert.equal((await create()).status, 409);
    await Costume.updateOne(
      { _id: item._id },
      { $set: { rentalSecurityDeposit: 100000, rentalDailyPrice: null } },
    );
    assert.equal((await create()).status, 409);
    await Costume.updateOne({ _id: item._id }, { $set: { rentalDailyPrice: 50000 } });
    process.env.RENTAL_MIN_LEAD_HOURS = '24';
    assert.throws(
      () =>
        validateRentalServiceDates(
          readRentalPeriod('2026-11-11', '2026-11-11', false),
          new Date('2026-11-10T13:00:00+07:00'),
        ),
      /24/,
    );
    process.env.RENTAL_MIN_LEAD_HOURS = '0';
    process.env.RENTAL_CLOSED_WEEKDAYS = String(new Date('2099-10-10T00:00:00Z').getUTCDay());
    assert.equal((await create()).status, 409);
    process.env.RENTAL_CLOSED_WEEKDAYS = '';
  });
  await t.test(
    'two concurrent customers cannot reserve the same last item; retry preserves the QR',
    async () => {
      const keys = ['single-winner-client', 'single-winner-other'];
      const results = await Promise.all([
        create(client, data(), keys[0]),
        create(other, data(), keys[1]),
      ]);
      assert.deepEqual(results.map((row) => row.status).sort(), [201, 409]);
      const index = results.findIndex((row) => row.status === 201),
        order = results[index].body.data;
      assert.equal(order.status, 'awaiting_deposit');
      assert.equal(order.quote.fee, 50000);
      assert.equal(order.quote.deposit, 100000);
      assert.ok(order.quote.acceptedAt);
      assert.match(order.depositPayment.qrUrl, /RENT/);
      const replay = await create(index ? other : client, data(), keys[index]);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.data.depositPayment.reference, order.depositPayment.reference);
      assert.equal((await call('/rentals/' + order._id, index ? client : other)).status, 404);
      await reset();
    },
  );
  await t.test('limits unpaid holds and releases expired or withdrawn orders', async () => {
    const a = (await create(client, data(10))).body.data;
    await create(client, data(13));
    assert.equal((await create(client, data(16))).status, 409);
    assert.equal((await action(a._id, client, 'withdraw')).status, 200);
    const c = await create(client, data(16));
    assert.equal(c.status, 201);
    await Rental.updateMany(
      { status: 'awaiting_deposit' },
      { $set: { 'reservation.expiresAt': new Date(0) } },
    );
    await expireRentalReservations();
    assert.equal(await Rental.countDocuments({ status: 'expired' }), 2);
    assert.equal((await create(other, data(16))).status, 201);
    await reset();
  });
  await t.test(
    'partial deposit locks cancellation, a duplicate credits once, and full deposit confirms',
    async () => {
      const order = (await create()).body.data;
      const first = await transfer(order, 40000);
      assert.equal(first.receipt.status, 'applied');
      assert.equal((await get(order._id)).status, 'awaiting_deposit');
      for (const name of ['withdraw', 'change.request', 'change.accept', 'quote.accept'])
        assert.equal((await action(order._id, client, name, { kind: 'cancel' })).status, 409);
      await transfer(order, 40000, first.payload);
      assert.equal((await get(order._id)).payment.netReceived, 40000);
      assert.equal(
        (
          await action(order._id, finance, 'payment.record', {
            kind: 'deposit',
            amount: 60000,
            method: 'bank_transfer',
            reference: 'MANUAL-DUPLICATE',
          })
        ).status,
        409,
      );
      await transfer(order, 60000);
      const paid = await get(order._id);
      assert.equal(paid.status, 'confirmed');
      assert.equal(paid.depositPayment.status, 'paid');
      assert.equal(paid.payment.netReceived, 100000);
      assert.equal(
        (
          await action(order._id, finance, 'payment.record', {
            kind: 'balance',
            amount: 50000,
            method: 'bank_transfer',
            reference: 'MANUAL-DUPLICATE-BALANCE',
          })
        ).status,
        409,
      );
      assert.equal(await Transaction.countDocuments({ rentalOrder: order._id }), 2);
      const balance = await transfer(order, 50000);
      assert.equal(balance.receipt.status, 'review');
      assert.equal(
        (
          await call(
            '/payments/sepay/receipts/' + balance.receipt._id + '/resolve-rental',
            finance,
            { rentalId: order._id, note: 'Đối soát phí thuê chuyển khoản sau cọc' },
          )
        ).status,
        200,
      );
      const ready = await get(order._id);
      assert.equal(ready.payment.netReceived, 150000);
      assert.equal(ready.readyForHandover, true);
      assert.equal(ready.reservationIssue, undefined);
      assert.equal(await Transaction.countDocuments({ rentalOrder: order._id }), 3);
      await reset();
    },
  );
  await t.test(
    'late payment rechecks availability; unavailable stock preserves money for refund',
    async () => {
      const order = (await create()).body.data;
      await Rental.updateOne(
        { _id: order._id },
        { $set: { 'reservation.expiresAt': new Date(0) } },
      );
      await expireRentalReservations();
      const competitor = await create(other);
      assert.equal(competitor.status, 201);
      await transfer(order, 100000);
      const failed = await get(order._id);
      assert.equal(failed.status, 'payment_review');
      assert.equal(failed.payment.netReceived, 100000);
      assert.equal(failed.payment.refundDue, 100000);
      assert.equal(
        (
          await action(order._id, admin, 'fulfillment.refund', {
            note: 'Không còn hàng sau hạn giữ',
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await action(order._id, finance, 'payment.record', {
            kind: 'refund',
            amount: 100000,
            method: 'bank_transfer',
            reference: 'REFUND-QA',
          })
        ).status,
        200,
      );
      assert.equal((await get(order._id)).payment.refundDue, 0);
      await reset();
    },
  );
  await t.test('late full payment confirms when stock is still free', async () => {
    const order = (await create()).body.data;
    await Rental.updateOne({ _id: order._id }, { $set: { 'reservation.expiresAt': new Date(0) } });
    await expireRentalReservations();
    await transfer(order, 100000);
    assert.equal((await get(order._id)).status, 'confirmed');
    await reset();
  });
  await t.test(
    'overpayment and wrong content require audited finance reconciliation; clients cannot apply it',
    async () => {
      const order = (await create()).body.data;
      const { receipt } = await transfer(order, 110000);
      assert.equal(receipt.status, 'review');
      assert.equal((await get(order._id)).payment.netReceived, 0);
      const route = '/payments/sepay/receipts/' + receipt._id + '/resolve-rental';
      const body = { rentalId: order._id, note: 'Đã kiểm tra người chuyển và tiền thực về' };
      assert.equal((await call(route, client, body)).status, 403);
      assert.equal((await call(route, finance, body)).status, 200);
      assert.equal((await call(route, finance, body)).status, 200);
      assert.equal((await get(order._id)).payment.netReceived, 110000);
      assert.equal(await Transaction.countDocuments({ rentalOrder: order._id }), 1);
      await reset();
      const next = (await create()).body.data;
      const wrong = await transfer(next, 100000, { content: 'KHACH GHI SAI NOI DUNG' });
      assert.equal(wrong.receipt.status, 'review');
      assert.equal(
        (
          await call('/payments/sepay/receipts/' + wrong.receipt._id + '/resolve-rental', finance, {
            rentalId: next._id,
            note: 'Đối chiếu sao kê và liên hệ khách',
          })
        ).status,
        200,
      );
      assert.equal((await get(next._id)).status, 'confirmed');
      await reset();
    },
  );
  await t.test(
    'damaged return flags a future paid rental and studio can release it for a full refund',
    async () => {
      const current = (await create()).body.data;
      const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
      const period = readRentalPeriod(today, today, false);
      await Rental.updateOne(
        { _id: current._id },
        {
          $set: { 'quote.receiveDate': period.receiveDate, 'quote.returnDate': period.returnDate },
        },
      );
      assert.equal(
        (
          await action(current._id, finance, 'payment.record', {
            kind: 'balance',
            amount: 150000,
            method: 'cash',
          })
        ).status,
        200,
      );
      assert.equal((await action(current._id, admin, 'handover')).status, 200);
      const future = (await create(other)).body.data;
      await transfer(future, 100000);
      assert.equal((await get(future._id, other)).status, 'confirmed');
      assert.equal(
        (
          await action(current._id, admin, 'return', {
            lines: [{ costumeId: String(item._id), size: 'M', good: 0, damaged: 1, lost: 0 }],
          })
        ).status,
        200,
      );
      assert.match((await get(future._id, other)).reservationIssue, /Cần xử lý giao hàng/);
      assert.equal(
        (
          await action(future._id, admin, 'fulfillment.refund', {
            note: 'Mẫu hỏng trước ngày giao, studio hoàn toàn bộ tiền',
          })
        ).status,
        200,
      );
      assert.equal((await get(future._id, other)).payment.refundDue, 100000);
      assert.equal(
        (
          await action(current._id, finance, 'payment.record', {
            kind: 'refund',
            amount: 1,
            method: 'cash',
          })
        ).status,
        409,
        'Do not refund security deposit before customer accepts return settlement',
      );
      assert.equal(
        (
          await action(current._id, admin, 'settlement.propose', {
            charges: [{ label: 'Phí sửa đồ đã kiểm tra', amount: 20000 }],
            note: 'Đối soát nhận trả',
          })
        ).status,
        200,
      );
      const settled = await get(current._id);
      assert.equal(
        (
          await action(current._id, client, 'settlement.accept', {
            settlementVersion: settled.settlement.version,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await action(current._id, finance, 'payment.record', {
            kind: 'refund',
            amount: 80000,
            method: 'cash',
          })
        ).status,
        200,
      );
      assert.equal((await get(current._id)).status, 'completed');
      await Costume.updateOne(
        { _id: item._id },
        { $set: { inventory: [{ size: 'M', quantity: 1, condition: 'good' }] } },
      );
      await reset();
    },
  );
  await t.test(
    'money arriving after an unpaid withdrawal remains reviewable for refund without reopening the order',
    async () => {
      const order = (await create()).body.data;
      assert.equal((await action(order._id, client, 'withdraw')).status, 200);
      const { receipt } = await transfer(order, 100000);
      assert.equal(receipt.status, 'review');
      const response = await call(
        '/payments/sepay/receipts/' + receipt._id + '/resolve-rental',
        finance,
        { rentalId: order._id, note: 'Tiền về sau khi khách rút đơn chưa cọc; ghi nhận để hoàn' },
      );
      assert.equal(response.status, 200);
      const updated = await get(order._id);
      assert.equal(updated.status, 'cancelled');
      assert.equal(updated.payment.refundDue, 100000);
      await reset();
    },
  );
  await t.test(
    'zero-deposit items confirm immediately and turnaround keeps cleaning stock unavailable',
    async () => {
      await Costume.updateOne({ _id: item._id }, { $set: { rentalSecurityDeposit: 0 } });
      const order = (await create()).body.data;
      assert.equal(order.status, 'confirmed');
      assert.equal(order.depositPayment, null);
      assert.equal((await create(other, data(11))).status, 409);
      assert.equal((await create(other, data(12))).status, 201);
      await Rental.updateOne(
        { _id: order._id },
        {
          $set: {
            status: 'returned',
            returnedAt: new Date('2099-10-10T10:00:00+07:00'),
            returns: [{ costumeId: item._id, size: 'M', good: 1, damaged: 0, lost: 0 }],
          },
        },
      );
      const holds = await loadRentalHolds([String(item._id)]);
      assert.deepEqual(
        getRentalAvailability(
          item,
          readRentalPeriod('2099-10-11', '2099-10-11', false),
          holds.orders,
          holds.schedules,
        ),
        {},
      );
      await reset();
    },
  );
  await t.test(
    'local demo button confirms only its owner sandbox order and retries credit once',
    async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      process.env.SEPAY_DEMO_UI = 'true';
      try {
        await Costume.updateOne({ _id: item._id }, { $set: { rentalSecurityDeposit: 100000 } });
        const order = (await create()).body.data;
        assert.equal(order.depositPayment.demoSimulation, true);
        const route = '/payments/sepay/sandbox/simulate',
          body = { reference: order.depositPayment.reference },
          key = 'local-ui-double-click';
        assert.equal((await call(route, other, body, key)).status, 404);
        const results = await Promise.all([
          call(route, client, body, key),
          call(route, client, body, key),
        ]);
        assert.ok(
          results.every((row) => row.status === 200),
          JSON.stringify(results),
        );
        assert.equal((await call(route, client, body, key)).status, 200);
        assert.equal((await get(order._id)).status, 'confirmed');
        assert.equal((await get(order._id)).payment.netReceived, 100000);
        assert.equal(await Receipt.countDocuments({}), 1);
        assert.equal(await Receipt.countDocuments({ hasConflict: true }), 0);
        process.env.NODE_ENV = 'production';
        assert.equal((await call(route, client, body, key)).status, 404);
        process.env.NODE_ENV = 'development';
        process.env.SEPAY_MODE = 'live';
        assert.equal((await call(route, client, body, key)).status, 404);
        process.env.SEPAY_MODE = 'sandbox';
        process.env.SEPAY_DEMO_UI = 'false';
        assert.equal((await call(route, client, body, key)).status, 404);
      } finally {
        process.env.NODE_ENV = previous;
        process.env.SEPAY_MODE = 'sandbox';
        delete process.env.SEPAY_DEMO_UI;
        await reset();
      }
    },
  );
  if (process.env.RENTAL_BROWSER_TEST === 'true')
    await t.test('desktop and mobile browser checkout with the local payment button', async () => {
      await Costume.updateOne({ _id: item._id }, { $set: { rentalSecurityDeposit: 100000 } });
      process.env.NODE_ENV = 'development';
      process.env.SEPAY_DEMO_UI = 'true';
      await require('../../ops/tests/rental-auto-checkout-browser.cjs')({
        apiOrigin: base,
        client,
        token: jwt.sign({ id: String(client._id) }, process.env.JWT_SECRET),
        itemId: String(item._id),
        get,
      });
    });
});
