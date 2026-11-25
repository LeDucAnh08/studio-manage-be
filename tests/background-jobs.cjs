// Real BullMQ/Redis + disposable MongoDB replica set, fake external providers only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
const uri = new URL(
  process.env.MONGO_TEST_URI ||
    'mongodb://127.0.0.1:27047/?replicaSet=concept-test&directConnection=true',
);
assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname));
uri.pathname = '/studio_sepay_jobs_test';
const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../.workflow-tools/background-jobs/redis-test.json')),
);
assert.equal(settings.port, 6386);
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: uri.toString(),
  REDIS_URL: settings.url,
  BACKGROUND_JOBS_MODE: 'bullmq',
  BACKGROUND_JOBS_PREFIX: `jobs-test-${randomUUID().slice(0, 8)}`,
  EMAIL_ENABLED: 'true',
  EMAIL_MODE: 'test',
  EMAIL_PUBLIC_URL: 'http://127.0.0.1:4013',
  EMAIL_FROM: 'Test <notify@example.test>',
  RESEND_API_KEY: '',
  JWT_SECRET: 'jobs-tests-only-signing-secret-32-characters',
  SEPAY_ENABLED: 'false',
  CLIENT_PORTAL_ENABLED: 'true',
  CLIENT_WORKFLOW_ENABLED: 'true',
  CONCEPT_BOOKING_ENABLED: 'true',
  GOOGLE_DRIVE_API_KEY: 'fake-drive-key',
});
require('ts-node/register/transpile-only');
const mongoose = require('mongoose'),
  express = require('express'),
  jwt = require('jsonwebtoken');
const { Worker } = require('bullmq');
const configModule = require('../src/config/queue');
const {
  initializeJobRuntime,
  assertJobRuntime,
  getQueue,
  queueConnection,
  closeQueues,
} = require('../src/services/jobQueue');
const { dispatchPendingJobs } = require('../src/workers/outboxDispatcher');
const email = require('../src/services/email');
const { processEmailJob } = require('../src/workers/email');
const { processAlbumJob } = require('../src/workers/main');
const { executeAlbumOperation } = require('../src/services/backgroundOperations');
const { runMaintenance } = require('../src/workers/maintenance');
const User = require('../src/models/User').default,
  Outbox = require('../src/models/EmailOutbox').default;
const Operation = require('../src/models/BackgroundOperation').default,
  Booking = require('../src/models/Booking').default;
const Workflow = require('../src/models/BookingWorkflow').default,
  Album = require('../src/models/BookingAlbum').default;
const Photo = require('../src/models/BookingAlbumPhoto').default,
  ConceptOrder = require('../src/models/ConceptOrder').default;
const ConceptAlbum = require('../src/models/ConceptAlbum').default;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    const value = await fn();
    if (value) return value;
    await wait(50);
  }
  throw new Error('Timed out waiting for job');
}

test('background jobs recover durable work, preserve album permissions and stop cleanly', async (t) => {
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, 'studio_sepay_jobs_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([Outbox.init(), Operation.init(), Album.init()]);
  await initializeJobRuntime();
  const config = configModule.queueConfig();
  assert.equal(config.mode, 'bullmq');
  const connection = queueConnection(true);
  const emailWorker = new Worker('email', processEmailJob, {
    connection,
    prefix: config.prefix,
    concurrency: 2,
  });
  const albumWorker = new Worker('album-sync', processAlbumJob, {
    connection,
    prefix: config.prefix,
    concurrency: 1,
  });
  for (const worker of [emailWorker, albumWorker]) worker.on('error', () => {});
  const actualFetch = global.fetch;
  let driveCalls = 0,
    driveFails = false,
    duringDrive;
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'www.googleapis.com') return actualFetch(input, init);
    driveCalls++;
    if (duringDrive) {
      const fn = duringDrive;
      duringDrive = null;
      await fn();
    }
    if (driveFails) return Response.json({ error: 'fixture-quota' }, { status: 503 });
    if (url.pathname.endsWith('/queue_folder_001'))
      return Response.json({
        id: 'queue_folder_001',
        name: 'Queue album',
        mimeType: 'application/vnd.google-apps.folder',
      });
    return Response.json({
      files: [
        {
          id: 'queue_photo_001',
          name: 'Photo.jpg',
          mimeType: 'image/jpeg',
          version: '1',
          md5Checksum: 'stable-checksum',
          size: '100',
          imageMediaMetadata: { width: 800, height: 600 },
        },
      ],
    });
  };
  const users = await User.create(
    [0, 3, 6, 3].map((role, i) => ({
      username: `queue.actor.${i}`,
      password: 'QueueTest123!',
      roles: [role],
      isActive: true,
      email: `actor${i}@example.test`,
      emailVerifiedAt: new Date(),
    })),
  );
  const [admin, photographer, customer, otherPhoto] = users;
  const booking = await Booking.create({
    client: customer._id,
    package: new mongoose.Types.ObjectId(),
    packageName: 'Queue',
    packageSnapshot: { name: 'Queue', pricePerMember: 200 },
    pricePerMember: 200,
    members: 1,
    contactName: 'Customer',
    phone: '0901234567',
    location: 'Studio',
    startAt: '2099-11-20T01:00:00Z',
    endAt: '2099-11-20T05:00:00Z',
    status: 'approved',
  });
  const workflow = await Workflow.create({
    booking: booking._id,
    lifecycle: 'editing',
    assignedPhotographer: photographer._id,
    resources: {
      schedule: new mongoose.Types.ObjectId(),
      photographers: [photographer._id],
      costumes: [],
    },
    progress: { status: 'editing', deliveryVersion: 0 },
  });
  const app = express();
  app.use(express.json());
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use('/concept-orders', require('../src/routes/conceptOrders').default);
  app.use('/background-jobs', require('../src/routes/backgroundJobs').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    global.fetch = actualFetch;
    await Promise.allSettled([emailWorker.close(), albumWorker.close()]);
    connection.disconnect();
    for (const name of ['email', 'maintenance', 'album-sync'])
      await getQueue(name).obliterate({ force: true });
    await closeQueues();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(mongoose.connection.name, 'studio_sepay_jobs_test');
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  let sequence = 0;
  const call = async (route, actor = admin, body, key = `queue-request-${++sequence}`) => {
    const response = await actualFetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body ? 'POST' : 'GET',
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
  const newEmail = () =>
    Outbox.create({
      dedupeKey: `queue-email-${randomUUID()}`,
      kind: 'concept_update',
      user: customer._id,
      conceptOrder: concept._id,
      to: customer.email,
      mode: 'test',
      payload: {
        from: process.env.EMAIL_FROM,
        to: customer.email,
        subject: 'Test',
        text: 'Queue fixture',
      },
    });
  const concept = await ConceptOrder.create({
    client: customer._id,
    concept: new mongoose.Types.ObjectId(),
    package: new mongoose.Types.ObjectId(),
    snapshot: { name: 'Concept queue', retouchQuota: 1, extraPhotoPrice: 100, deposit: 30 },
    contactName: 'Customer',
    phone: '0901234567',
    people: 1,
    photographer: photographer._id,
    startAt: '2099-11-20T01:00:00Z',
    endAt: '2099-11-20T02:00:00Z',
    originalStartAt: '2099-11-20T01:00:00Z',
    status: 'shot',
    reservation: { expiresAt: new Date() },
    checkoutKey: 'queue-checkout',
    fingerprint: 'test-fixture',
  });
  await t.test(
    'config rejects unsafe namespaces; scope separates databases and legacy remains default',
    async () => {
      const before = { ...process.env };
      try {
        delete process.env.BACKGROUND_JOBS_MODE;
        assert.equal(configModule.queueConfig().mode, 'legacy');
        process.env.BACKGROUND_JOBS_MODE = 'bullmq';
        process.env.BACKGROUND_JOBS_PREFIX = 'bad:prefix';
        assert.throws(configModule.queueConfig);
        process.env.BACKGROUND_JOBS_PREFIX = before.BACKGROUND_JOBS_PREFIX;
        process.env.MONGO_URI = uri.toString().replace('jobs_test', 'jobs_other');
        assert.notEqual(configModule.queueConfig().prefix, config.prefix);
      } finally {
        Object.keys(process.env).forEach((k) => {
          if (!(k in before)) delete process.env[k];
        });
        Object.assign(process.env, before);
      }
    },
  );
  await t.test(
    'email committed before enqueue is dispatched once; redis job payload contains only IDs',
    async () => {
      const row = await newEmail();
      await dispatchPendingJobs();
      await until(async () => (await Outbox.findById(row._id)).status === 'sent');
      const job = await getQueue('email').getJob(`email-${row._id}`);
      assert.deepEqual(Object.keys(job.data).sort(), ['outboxId', 'schemaVersion']);
      await until(async () => (await job.getState()) === 'completed');
      await job.remove();
      await dispatchPendingJobs();
      assert.equal(await getQueue('email').getJob(`email-${row._id}`), undefined);
      assert.equal((await Outbox.findById(row._id)).attempts, 1);
    },
  );
  await t.test('transient retry preserves provider key and original attempt window', async () => {
    let calls = 0;
    const seen = [];
    const original = email.processOneEmailOutbox;
    const mock = t.mock.method(email, 'processOneEmailOutbox', (id, transport, guard) =>
      original(
        id,
        async (payload, key) => {
          seen.push(key);
          if (++calls === 1) throw new Error('fixture-network-error');
          return 'provider-test-id';
        },
        guard,
      ),
    );
    const row = await newEmail();
    const q = getQueue('email');
    const accelerate = async (job) => {
      if (job?.data.outboxId === String(row._id))
        await Outbox.updateOne({ _id: row._id }, { $set: { nextAttemptAt: new Date() } });
    };
    emailWorker.on('failed', accelerate);
    try {
      await q.add(
        'email',
        { schemaVersion: 1, outboxId: String(row._id) },
        { jobId: `email-${row._id}`, backoff: { type: 'fixed', delay: 200 } },
      );
      await until(async () => (await Outbox.findById(row._id)).status === 'sent');
      const saved = await Outbox.findById(row._id);
      assert.equal(saved.attempts, 2);
      assert.ok(saved.firstAttemptAt);
      assert.deepEqual(seen, [row.dedupeKey, row.dedupeKey]);
    } finally {
      mock.mock.restore();
      emailWorker.off('failed', accelerate);
    }
  });
  await t.test(
    'terminal and uncertain deliveries never get automatically queued again',
    async () => {
      const row = await newEmail();
      await Outbox.updateOne(
        { _id: row._id },
        {
          $set: {
            status: 'delivery_unknown',
            attempts: 10,
            firstAttemptAt: new Date(Date.now() - 24 * 3600000),
          },
        },
      );
      await dispatchPendingJobs();
      assert.equal(await getQueue('email').getJob(`email-${row._id}`), undefined);
      const failed = await newEmail();
      await Outbox.updateOne({ _id: failed._id }, { $set: { status: 'failed' } });
      await dispatchPendingJobs();
      assert.equal(await getQueue('email').getJob(`email-${failed._id}`), undefined);
    },
  );
  let version = 0;
  const enqueueYearbook = async (actor = photographer, key, extra = {}) =>
    call(
      `/bookings/${booking._id}/album/${version ? 'sync' : 'configure'}`,
      actor,
      {
        expectedVersion: version,
        ...(!version
          ? {
              title: 'Queue album',
              limit: 2,
              folders: ['https://drive.google.com/drive/folders/queue_folder_001'],
            }
          : {}),
        ...extra,
      },
      key,
    );
  await t.test(
    'HTTP 202 is durable and does not perform Drive work in API; operation access is scoped',
    async () => {
      await albumWorker.pause();
      const before = driveCalls;
      const result = await enqueueYearbook(photographer, 'queue-album-first');
      assert.equal(result.status, 202, JSON.stringify(result.body));
      assert.equal(driveCalls, before);
      const op = result.body.data.backgroundOperation;
      assert.equal((await call(`/background-jobs/operations/${op.id}`, customer)).status, 404);
      assert.equal((await call(`/background-jobs/operations/${op.id}`, otherPhoto)).status, 404);
      await dispatchPendingJobs();
      const health = await call('/background-jobs/health', admin);
      assert.equal(health.status, 200);
      const waitingAlbum = health.body.data.queues.find((queue) => queue.name === 'album-sync');
      assert.equal(waitingAlbum.counts.waiting, 1);
      assert.ok(waitingAlbum.oldestWaitingAgeMs >= 0);
      await albumWorker.resume();
      await until(async () => (await Operation.findById(op.id)).status === 'succeeded');
      const album = await Album.findOne({ booking: booking._id });
      version = album.version;
      assert.equal(version, 1);
      assert.equal(await Photo.countDocuments({ album: album._id }), 1);
      const replay = await call(
        `/bookings/${booking._id}/album/configure`,
        photographer,
        {
          expectedVersion: 0,
          title: 'Queue album',
          limit: 2,
          folders: ['https://drive.google.com/drive/folders/queue_folder_001'],
        },
        'queue-album-first',
      );
      assert.equal(replay.status, 202);
      assert.equal(replay.body.data.backgroundOperation.id, op.id);
      assert.equal((await call('/background-jobs/health', photographer)).status, 403);
    },
  );
  await t.test('lost Redis job is recovered, and selection/notes survive replay', async () => {
    await albumWorker.pause();
    const album = await Album.findOne({ booking: booking._id });
    await Photo.updateOne(
      { album: album._id },
      { $set: { selected: true, note: 'Keep this note' } },
    );
    const result = await enqueueYearbook();
    assert.equal(result.status, 202);
    const id = result.body.data.backgroundOperation.id;
    await dispatchPendingJobs();
    await (await getQueue('album-sync').getJob(`album-${id}`)).remove();
    await dispatchPendingJobs();
    await albumWorker.resume();
    await until(async () => (await Operation.findById(id)).status === 'succeeded');
    const photo = await Photo.findOne({ album: album._id });
    assert.equal(photo.selected, true);
    assert.equal(photo.note, 'Keep this note');
    version = (await Album.findById(album._id)).version;
    assert.equal(version, 2);
  });
  await t.test('version conflict and revoked access do not change published snapshot', async () => {
    await albumWorker.pause();
    const result = await enqueueYearbook();
    const id = result.body.data.backgroundOperation.id;
    await Album.updateOne({ booking: booking._id }, { $inc: { version: 1 } });
    version++;
    await dispatchPendingJobs();
    await albumWorker.resume();
    await until(async () => (await Operation.findById(id)).status === 'failed');
    assert.equal((await Album.findOne({ booking: booking._id })).version, version);
    await albumWorker.pause();
    const next = await enqueueYearbook();
    const denied = next.body.data.backgroundOperation.id;
    await Workflow.updateOne(
      { _id: workflow._id },
      {
        $set: { assignedPhotographer: otherPhoto._id, 'resources.photographers': [otherPhoto._id] },
      },
    );
    await dispatchPendingJobs();
    await albumWorker.resume();
    await until(async () => (await Operation.findById(denied)).status === 'failed');
    assert.equal((await Album.findOne({ booking: booking._id })).version, version);
    await Workflow.updateOne(
      { _id: workflow._id },
      {
        $set: {
          assignedPhotographer: photographer._id,
          'resources.photographers': [photographer._id],
        },
      },
    );
  });
  await t.test(
    'permission is checked again after loading Drive and before committing',
    async () => {
      await albumWorker.pause();
      const result = await enqueueYearbook();
      const id = result.body.data.backgroundOperation.id;
      duringDrive = () => User.updateOne({ _id: photographer._id }, { $set: { isActive: false } });
      await dispatchPendingJobs();
      await albumWorker.resume();
      await until(async () => (await Operation.findById(id)).status === 'failed');
      assert.equal((await Album.findOne({ booking: booking._id })).version, version);
      await User.updateOne({ _id: photographer._id }, { $set: { isActive: true } });
    },
  );
  await t.test('Drive outages terminate within budget and retain previous snapshot', async () => {
    await albumWorker.pause();
    const result = await enqueueYearbook();
    const id = result.body.data.backgroundOperation.id;
    driveFails = true;
    try {
      for (let i = 0; i < 5; i++) {
        await Operation.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date() } });
        await executeAlbumOperation(id).catch(() => {});
      }
      const saved = await Operation.findById(id);
      assert.equal(saved.status, 'failed');
      assert.equal(saved.attempts, 5);
      assert.equal((await Album.findOne({ booking: booking._id })).version, version);
    } finally {
      driveFails = false;
      await albumWorker.resume();
    }
  });
  await t.test(
    'concept synchronization uses the same durable operation and current assignment checks',
    async () => {
      const result = await call(`/concept-orders/${concept._id}/album/sync`, photographer, {
        expectedVersion: 0,
        title: 'Concept queue',
        folders: ['https://drive.google.com/drive/folders/queue_folder_001'],
      });
      assert.equal(result.status, 202, JSON.stringify(result.body));
      const id = result.body.data.backgroundOperation.id;
      await dispatchPendingJobs();
      await until(async () => (await Operation.findById(id)).status === 'succeeded');
      assert.equal((await ConceptAlbum.findOne({ order: concept._id })).version, 1);
    },
  );
  await t.test(
    'mode barrier prevents workers from continuing after rollback; maintenance can safely rerun',
    async () => {
      await runMaintenance();
      await runMaintenance();
      await mongoose.connection
        .collection('backgroundjobruntime')
        .updateOne({ _id: 'runtime' }, { $set: { mode: 'legacy' } });
      await assert.rejects(assertJobRuntime);
      await initializeJobRuntime();
      await assertJobRuntime();
    },
  );
  await t.test(
    'legacy fallback keeps synchronous album commands compatible in both services',
    async () => {
      await emailWorker.pause();
      await albumWorker.pause();
      process.env.BACKGROUND_JOBS_MODE = 'legacy';
      await initializeJobRuntime();
      try {
        const result = await call(`/bookings/${booking._id}/album/sync`, photographer, {
          expectedVersion: version,
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.data.version, ++version);
        const conceptResult = await call(
          `/concept-orders/${concept._id}/album/sync`,
          photographer,
          {
            expectedVersion: 1,
            title: 'Concept queue',
            folders: ['https://drive.google.com/drive/folders/queue_folder_001'],
          },
        );
        assert.equal(conceptResult.status, 200, JSON.stringify(conceptResult.body));
        assert.equal(conceptResult.body.data.version, 2);
      } finally {
        process.env.BACKGROUND_JOBS_MODE = 'bullmq';
        await initializeJobRuntime();
        await emailWorker.resume();
        await albumWorker.resume();
      }
    },
  );
  await t.test(
    'Redis restart preserves waiting jobs and outage does not prevent durable API work',
    async () => {
      await emailWorker.pause();
      await albumWorker.pause();
      const result = await enqueueYearbook();
      assert.equal(result.status, 202, JSON.stringify(result.body));
      const id = result.body.data.backgroundOperation.id;
      await dispatchPendingJobs();
      const client = new (require('ioredis'))(settings.url, {
        retryStrategy: null,
        maxRetriesPerRequest: 1,
      });
      client.on('error', () => {});
      try {
        await client.shutdown('SAVE');
      } catch {
      } finally {
        client.disconnect();
      }
      const row = await newEmail();
      assert.equal((await call(`/bookings/${booking._id}/album`, photographer)).status, 200);
      const started = Date.now();
      await assert.rejects(() => getQueue('email').getJobCounts());
      assert.ok(Date.now() - started < 12000);
      const restart = spawnSync(
        process.execPath,
        [path.join(__dirname, '../../ops/background-jobs.cjs'), 'redis-start', '--test'],
        { windowsHide: true, timeout: 30000, stdio: 'pipe' },
      );
      assert.equal(restart.status, 0, 'Private test Redis restart failed');
      await until(async () => {
        try {
          return !!(await getQueue('album-sync').getJob(`album-${id}`));
        } catch {
          return false;
        }
      });
      await dispatchPendingJobs();
      await emailWorker.resume();
      await albumWorker.resume();
      await until(async () => (await Operation.findById(id)).status === 'succeeded');
      await until(async () => (await Outbox.findById(row._id)).status === 'sent');
      assert.equal((await Outbox.findById(row._id)).attempts, 1);
      version++;
    },
  );
  await t.test(
    'a real worker entrypoint processes jobs and drains on Windows IPC shutdown',
    async () => {
      await emailWorker.pause();
      await albumWorker.pause();
      const row = await newEmail();
      const child = spawn(process.execPath, [path.join(__dirname, '../dist/workers/main.js')], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let log = '';
      child.stdout.on('data', (d) => {
        log += d;
      });
      child.stderr.on('data', (d) => {
        log += d;
      });
      try {
        await until(async () => (await Outbox.findById(row._id)).status === 'sent');
        child.send('shutdown');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker did not shut down')), 10000);
          child.once('exit', (code) => {
            clearTimeout(timer);
            assert.equal(code, 0, log);
            resolve();
          });
        });
      } finally {
        if (child.exitCode === null) child.kill();
        await emailWorker.resume();
        await albumWorker.resume();
      }
    },
  );
});
