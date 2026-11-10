// Real HTTP + transactions in a disposable local database. No external email is sent.
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
Object.assign(process.env, {
  JWT_SECRET: 'email-tests-only-signing-secret-minimum-32',
  CLIENT_PORTAL_ENABLED: 'true',
  CLIENT_WORKFLOW_ENABLED: 'true',
  SEPAY_ENABLED: 'true',
  SEPAY_MODE: 'sandbox',
  SEPAY_SANDBOX_DATABASE: 'studio_sepay_email_test',
  SEPAY_WEBHOOK_SECRET: 'email-test-sepay-signing-secret-minimum-32',
  PAYMENT_BANK_CODE: 'MBBank',
  SEPAY_BANK_GATEWAY: 'MBBank',
  PAYMENT_BANK_NAME: 'MBBank',
  PAYMENT_ACCOUNT_NUMBER: 'SBSTUDIO001',
  PAYMENT_ACCOUNT_NAME: 'EMAIL TEST STUDIO',
  EMAIL_ENABLED: 'true',
  EMAIL_MODE: 'test',
  EMAIL_PUBLIC_URL: 'http://127.0.0.1:4013',
  EMAIL_FROM: 'Yume Test <notifications@example.test>',
  RESEND_API_KEY: '',
  NODE_ENV: 'test',
});
require('ts-node/register/transpile-only');
const mongoose = require('mongoose'),
  express = require('express'),
  jwt = require('jsonwebtoken');
const User = require('../src/models/User').default,
  Booking = require('../src/models/Booking').default;
const Workflow = require('../src/models/BookingWorkflow').default,
  Package = require('../src/models/Package').default;
const Outbox = require('../src/models/EmailOutbox').default;
const { processEmailOutbox, verificationToken, emailConfig } = require('../src/services/email');

test('verified email and package approval notifications survive retries without external delivery', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
  uri.pathname = '/studio_sepay_email_test';
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, 'studio_sepay_email_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([Outbox.createIndexes(), Workflow.createIndexes(), Booking.createIndexes()]);
  const users = await User.create(
    [0, 3, 6, 6].map((role, index) => ({
      username: `email.role${index}`,
      name: `Actor ${index}`,
      roles: [role],
      isActive: true,
      password: 'EmailTest123!',
    })),
  );
  const [admin, photographer, client, other] = users;
  const pkg = await Package.create({
    name: 'Gói email <test>',
    pricePerMember: 500000,
    studentsPerCrew: 15,
    deliveryDays: 5,
    costumes: [],
  });
  const app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth').default);
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use((err, req, res, next) => res.status(500).json({ message: 'test_error' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(mongoose.connection.name, 'studio_sepay_email_test');
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  let sequence = 0;
  const call = async (route, actor, body, method = body ? 'POST' : 'GET', key) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
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
  const requestVerification = (actor, email) => call('/auth/email/request', actor, { email });
  const getToken = async (actor) => {
    const job = await Outbox.findOne({ user: actor._id, kind: 'verify_email' })
      .sort({ createdAt: -1 })
      .select('+payload');
    return verificationToken(String(actor._id), job.to, job.payload.nonce);
  };
  const make = async (actor = client, approve = true) => {
    const day = new Date(Date.UTC(2099, 10, ++sequence)).toISOString().slice(0, 10);
    const result = await call(
      '/bookings',
      actor,
      {
        packageId: String(pkg._id),
        members: 1,
        className: `Email ${sequence}`,
        contactName: 'Khách thử',
        phone: '0901234567',
        location: 'Studio',
        startAt: `${day}T08:00:00+07:00`,
        endAt: `${day}T12:00:00+07:00`,
        students: [{ name: 'Học sinh', phone: '0901234567', pantsSize: '28', shirtSize: 'M' }],
        packageAgreement: {
          accepted: true,
          pricePerMember: 500000,
          depositPercent: 30,
          holdHours: 24,
          detailsVersion: 0,
          updatedAt: pkg.updatedAt.toISOString(),
        },
      },
      'POST',
      `email-create-${sequence}`,
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const id = result.body.data._id;
    const version = (await Workflow.findOne({ booking: id }))?.version ?? 0;
    assert.equal(
      (
        await call(
          `/bookings/${id}/workflow/actions`,
          admin,
          {
            expectedVersion: version,
            action: 'photographer.assign',
            photographerId: String(photographer._id),
          },
          'POST',
          `email-assign-${sequence}`,
        )
      ).status,
      200,
    );
    if (approve)
      assert.equal(
        (
          await call(
            `/bookings/${id}/review`,
            admin,
            { status: 'approved', note: 'Duyệt thử email' },
            'PATCH',
          )
        ).status,
        200,
      );
    return id;
  };
  const jobFor = (id) => Outbox.findOne({ booking: id, kind: 'deposit_approved' });

  await t.test(
    'verification is authenticated, normalized, single use and never exposes secrets',
    async () => {
      assert.equal((await requestVerification(null, 'a@example.test')).status, 401);
      assert.equal((await requestVerification(client, 'bad\nemail')).status, 400);
      assert.equal((await requestVerification(client, ' CLIENT@Example.Test ')).status, 202);
      const token = await getToken(client);
      const me = await call('/auth/me', client);
      assert.equal(me.body.data.user.email, 'client@example.test');
      assert.equal(me.body.data.user.emailVerification, undefined);
      assert.equal((await Outbox.findOne({ kind: 'verify_email' })).payload, undefined);
      assert.equal((await call('/auth/email/confirm', other, { token })).status, 400);
      assert.equal((await requestVerification(client, 'client@example.test')).status, 429);
      await processEmailOutbox();
      const preview = await Outbox.findOne({ kind: 'verify_email' }).select('+testMessage');
      assert.equal(preview.status, 'sent');
      assert.ok(preview.testMessage.html.includes(`/account/verify-email#token=${token}`));
      assert.equal((await call('/auth/email/confirm', client, { token })).status, 200);
      assert.equal((await call('/auth/email/confirm', client, { token })).status, 400);
      assert.ok((await User.findById(client._id)).emailVerifiedAt);
      assert.equal(
        (
          await call(
            '/auth/profile',
            client,
            {
              name: 'Client updated',
              email: 'injected@example.test',
              emailVerifiedAt: new Date().toISOString(),
            },
            'PATCH',
          )
        ).status,
        200,
      );
      assert.equal((await User.findById(client._id)).email, 'client@example.test');
    },
  );
  let bookingId;
  await t.test(
    'approval enqueues once, renders safe content and concurrent workers send once',
    async () => {
      bookingId = await make();
      await Promise.all(
        [1, 2].map(() =>
          call(
            `/bookings/${bookingId}/review`,
            admin,
            { status: 'approved', note: 'Duyệt lặp' },
            'PATCH',
          ),
        ),
      );
      assert.equal(await Outbox.countDocuments({ booking: bookingId }), 1);
      let sends = 0;
      await Promise.all([
        processEmailOutbox(20, async () => {
          sends++;
          return 'mock-one';
        }),
        processEmailOutbox(20, async () => {
          sends++;
          return 'mock-two';
        }),
      ]);
      assert.equal(sends, 1);
      const job = await jobFor(bookingId).select('+testMessage');
      assert.equal(job.status, 'sent');
      assert.ok(job.testMessage.html.includes('Gói email &lt;test&gt;'));
      assert.ok(job.testMessage.html.includes(`/account/bookings/${bookingId}`));
      assert.ok(job.testMessage.text.includes('150.000'));
      assert.ok(job.testMessage.text.includes('giờ Việt Nam'));
      assert.ok(!job.testMessage.html.includes('vietqr.app'));
    },
  );
  await t.test(
    'an outbox persistence failure rolls back approval, provider failure never does',
    async () => {
      const id = await make(client, false),
        original = Outbox.updateOne;
      Outbox.updateOne = () => {
        throw new Error('test_outbox_db_down');
      };
      try {
        assert.equal(
          (
            await call(
              `/bookings/${id}/review`,
              admin,
              { status: 'approved', note: 'Duyệt' },
              'PATCH',
            )
          ).status,
          500,
        );
      } finally {
        Outbox.updateOne = original;
      }
      assert.equal((await Booking.findById(id)).status, 'pending');
      assert.equal((await Workflow.findOne({ booking: id })).depositPayment, undefined);
      assert.equal(
        (
          await call(
            `/bookings/${id}/review`,
            admin,
            { status: 'approved', note: 'Thử lại' },
            'PATCH',
          )
        ).status,
        200,
      );
      await processEmailOutbox(20, async () => {
        throw new Error('simulated_network_timeout');
      });
      let job = await jobFor(id).select('+payload');
      assert.equal(job.status, 'pending');
      assert.equal(job.deliveryUncertain, true);
      const snapshot = JSON.stringify(job.payload),
        key = job.dedupeKey;
      assert.equal((await Booking.findById(id)).status, 'approved');
      await Outbox.updateOne({ _id: job._id }, { $set: { nextAttemptAt: new Date(0) } });
      await processEmailOutbox(20, async (payload, requestKey) => {
        assert.equal(requestKey, key);
        assert.equal(JSON.stringify(payload), snapshot);
        return 'provider-existing-id';
      });
      assert.equal((await jobFor(id)).status, 'sent');
    },
  );
  await t.test(
    'cancelled, expired, paid and obsolete bank snapshots suppress queued messages',
    async () => {
      for (const reason of ['cancelled', 'expired', 'paid', 'bank_rotated']) {
        const id = await make();
        if (reason === 'cancelled')
          await Booking.updateOne({ _id: id }, { $set: { status: 'cancelled' } });
        if (reason === 'expired')
          await Workflow.updateOne(
            { booking: id },
            { $set: { 'packageReservation.expiresAt': new Date(0) } },
          );
        if (reason === 'paid')
          await Workflow.updateOne(
            { booking: id },
            {
              $set: {
                lifecycle: 'confirmed',
                'packageReservation.status': 'confirmed',
                'resources.schedule': new mongoose.Types.ObjectId(),
                payments: [{ kind: 'deposit', amount: 150000, method: 'bank_transfer' }],
              },
            },
          );
        const old = process.env.PAYMENT_ACCOUNT_NUMBER;
        if (reason === 'bank_rotated') process.env.PAYMENT_ACCOUNT_NUMBER = 'DIFFERENT123';
        try {
          await processEmailOutbox();
        } finally {
          process.env.PAYMENT_ACCOUNT_NUMBER = old;
        }
        assert.equal((await jobFor(id)).status, 'skipped', reason);
      }
    },
  );
  await t.test(
    'later verification queues an existing approval, retargets only an unattempted notice and persists cooldowns',
    async () => {
      const id = await make(other);
      assert.equal(await Outbox.countDocuments({ booking: id }), 0);
      const requests = await Promise.all(
        [1, 2, 3].map(() => requestVerification(other, 'other@example.test')),
      );
      assert.deepEqual(requests.map((row) => row.status).sort(), [202, 429, 429]);
      const tokenA = await getToken(other);
      assert.equal((await call('/auth/email/confirm', other, { token: tokenA })).status, 200);
      const old = await jobFor(id);
      assert.equal(old.to, 'other@example.test');
      await User.updateOne(
        { _id: other._id },
        { $set: { 'emailVerification.requestedAt': new Date(0) } },
      );
      assert.equal((await requestVerification(other, 'new@example.test')).status, 202);
      await processEmailOutbox();
      assert.equal((await jobFor(id)).status, 'skipped');
      assert.equal((await jobFor(id)).firstAttemptAt, undefined);
      const tokenB = await getToken(other);
      assert.equal((await call('/auth/email/confirm', other, { token: tokenB })).status, 200);
      const revived = await jobFor(id);
      assert.equal(revived.to, 'new@example.test');
      assert.equal(revived.status, 'pending');
      assert.equal(await Outbox.countDocuments({ booking: id }), 1);
      await processEmailOutbox();
      assert.equal((await jobFor(id)).status, 'sent');
    },
  );
  await t.test(
    'returning to the original address revives only its unattempted notice',
    async () => {
      const id = await make();
      await User.updateOne(
        { _id: client._id },
        { $set: { 'emailVerification.requestedAt': new Date(0) } },
      );
      assert.equal((await requestVerification(client, 'temporary@example.test')).status, 202);
      await processEmailOutbox();
      assert.equal((await jobFor(id)).status, 'skipped');
      await User.updateOne(
        { _id: client._id },
        { $set: { 'emailVerification.requestedAt': new Date(0) } },
      );
      assert.equal((await requestVerification(client, 'client@example.test')).status, 202);
      assert.equal(
        (await call('/auth/email/confirm', client, { token: await getToken(client) })).status,
        200,
      );
      assert.equal((await jobFor(id)).status, 'pending');
      assert.equal((await jobFor(id)).firstAttemptAt, undefined);
      await processEmailOutbox();
      assert.equal((await jobFor(id)).status, 'sent');
    },
  );
  await t.test(
    'expired verification and unknown delivery outside provider retention cannot auto-send',
    async () => {
      await User.updateOne(
        { _id: other._id },
        {
          $unset: { emailVerifiedAt: 1 },
          $set: { 'emailVerification.requestedAt': new Date(0), 'emailVerification.count': 1 },
        },
      );
      assert.equal((await requestVerification(other, 'expiry@example.test')).status, 202);
      const token = await getToken(other);
      await User.updateOne(
        { _id: other._id },
        { $set: { 'emailVerification.expiresAt': new Date(0) } },
      );
      assert.equal((await call('/auth/email/confirm', other, { token })).status, 400);
      await processEmailOutbox();
      assert.equal(
        (await Outbox.findOne({ user: other._id, to: 'expiry@example.test', kind: 'verify_email' }))
          .status,
        'skipped',
      );
      const id = await make();
      await Outbox.updateOne(
        { booking: id },
        {
          $set: {
            status: 'sending',
            leaseToken: 'crashed',
            lockedUntil: new Date(0),
            firstAttemptAt: new Date(Date.now() - 24 * 3600000),
          },
        },
      );
      let sent = 0;
      await processEmailOutbox(20, async () => {
        sent++;
        return 'should-not-send';
      });
      assert.equal(sent, 0);
      assert.equal((await jobFor(id)).status, 'delivery_unknown');
    },
  );
  await t.test(
    'lost lease cannot acknowledge a new worker and test mode never enables real sending',
    async () => {
      const id = await make();
      await processEmailOutbox(20, async () => {
        await Outbox.updateOne(
          { booking: id },
          { $set: { leaseToken: 'replacement', lockedUntil: new Date(Date.now() + 60000) } },
        );
        return 'accepted-with-lost-lease';
      });
      assert.equal((await jobFor(id)).status, 'sending');
      await Outbox.updateOne({ booking: id }, { $set: { lockedUntil: new Date(0) } });
      await processEmailOutbox();
      assert.equal((await jobFor(id)).status, 'sent');
      process.env.EMAIL_MODE = 'resend';
      process.env.EMAIL_PUBLIC_URL = 'https://studio.example';
      assert.throws(() => emailConfig(), /Sandbox/);
      process.env.EMAIL_MODE = 'test';
      process.env.EMAIL_PUBLIC_URL = 'http://external.example';
      assert.throws(() => emailConfig(), /HTTPS/);
      process.env.EMAIL_PUBLIC_URL = 'http://127.0.0.1:4013';
    },
  );
});
