// Private uploads over real HTTP/Mongo; isolated local DB and storage only.
const path = require('node:path'),
  fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const directory = path.resolve(__dirname, `../../.data/private-delivery-test-${process.pid}`);
Object.assign(process.env, {
  JWT_SECRET: 'delivery-http-test-signing-secret',
  CLIENT_PORTAL_ENABLED: 'true',
  CLIENT_WORKFLOW_ENABLED: 'true',
  EMAIL_ENABLED: 'false',
  PRIVATE_DELIVERY_DIR: directory,
});
require('ts-node/register/transpile-only');
const mongoose = require('mongoose'),
  express = require('express'),
  jwt = require('jsonwebtoken'),
  sharp = require('sharp');
const model = (name) => require(`../src/models/${name}`).default;
const User = model('User'),
  Booking = model('Booking'),
  Workflow = model('BookingWorkflow'),
  Photo = model('BookingDeliveryPhoto');
const { deliveryFile, cleanupDeliveryPhotos } = require('../src/services/bookingDelivery');

test('private edited photo uploads, versioned delivery and customer feedback', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
  uri.pathname = '/studio_delivery_test';
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, 'studio_delivery_test');
  await mongoose.connection.dropDatabase();
  await Photo.createIndexes();
  await fs.mkdir(directory, { recursive: true });
  const [admin, photographer, client, other, outsider, accountant] = await User.create(
    [0, 3, 6, 6, 3, 5].map((role, index) => ({
      username: `delivery.${index}`,
      name: `Actor ${index}`,
      roles: [role],
      isActive: true,
      password: 'DeliveryTest123!',
    })),
  );
  const app = express();
  app.use(express.json());
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use((err, req, res, next) => {
    if (!res.headersSent) res.status(500).json({ message: 'test_error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(mongoose.connection.name, 'studio_delivery_test');
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    assert.ok(directory.startsWith(path.resolve(__dirname, '../../.data') + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const call = (
    route,
    actor = client,
    body,
    method = body ? 'POST' : 'GET',
    key = `delivery-command-${++sequence}`,
  ) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method,
      headers: {
        ...(actor
          ? {
              Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET)}`,
            }
          : {}),
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        'Idempotency-Key': key,
      },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    });
  const image = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#ff385c' },
  })
    .withMetadata({ exif: { IFD0: { Artist: 'Private artist' } } })
    .png()
    .toBuffer();
  const otherImage = await sharp({
    create: { width: 110, height: 70, channels: 3, background: '#223344' },
  })
    .png()
    .toBuffer();
  const make = async () => {
    const booking = await Booking.create({
      client: client._id,
      package: new mongoose.Types.ObjectId(),
      packageName: 'Gói hậu kỳ',
      packageSnapshot: { name: 'Gói hậu kỳ', pricePerMember: 200 },
      pricePerMember: 200,
      members: 1,
      className: '12A',
      contactName: 'Khách',
      phone: '0901234567',
      location: 'Studio',
      startAt: '2099-11-20T08:00:00+07:00',
      endAt: '2099-11-20T12:00:00+07:00',
      status: 'approved',
    });
    await Workflow.create({
      booking: booking._id,
      lifecycle: 'editing',
      assignedPhotographer: photographer._id,
      resources: {
        schedule: new mongoose.Types.ObjectId(),
        photographers: [photographer._id],
        costumes: [],
      },
      progress: { status: 'editing', deliveryVersion: 0, revisionRequests: [] },
      quote: {
        version: 1,
        lines: [{ label: 'Ảnh', quantity: 1, unitPrice: 200 }],
        depositRequired: 50,
        proposedSchedule: {
          shootDate: '2099-11-20',
          startTime: '08:00',
          endTime: '12:00',
          location: 'Studio',
        },
        delivery: { targetDays: 5 },
        proposedBy: admin._id,
        proposedAt: new Date(),
        acceptedBy: client._id,
        acceptedAt: new Date(),
      },
      payments: [
        {
          kind: 'deposit',
          amount: 50,
          method: 'cash',
          recordedBy: admin._id,
          receivedAt: new Date(),
        },
      ],
    });
    return String(booking._id);
  };
  const upload = async (
    booking,
    actor = photographer,
    bytes = image,
    key = `upload-image-${++sequence}`,
  ) => {
    const form = new FormData();
    form.append('photo', new Blob([bytes], { type: 'image/png' }), 'edited.png');
    return call(`/bookings/${booking}/delivery/photos`, actor, form, 'POST', key);
  };
  const uploadOk = async (booking) => {
    const response = await upload(booking);
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    return result.data;
  };
  const action = async (booking, actor, type, data = {}, key) => {
    const w = await Workflow.findOne({ booking });
    return call(
      `/bookings/${booking}/workflow/actions`,
      actor,
      { expectedVersion: w.version, action: type, ...data },
      'POST',
      key,
    );
  };
  const publish = (booking, ids, key) =>
    action(
      booking,
      photographer,
      'progress.update',
      { status: 'delivered', deliveryPhotoIds: ids },
      key,
    );
  let first, id;
  await t.test(
    'only assigned studio staff upload; bytes are decoded and normalized privately',
    async () => {
      id = await make();
      for (const actor of [null, client, other, outsider, accountant])
        assert.ok([401, 403, 404].includes((await upload(id, actor)).status));
      assert.equal(
        (await upload(id, photographer, Buffer.from('<svg><script>alert(1)</script></svg>')))
          .status,
        400,
      );
      const key = 'same-upload-image-key';
      const response = await upload(id, photographer, image, key);
      first = (await response.json()).data;
      assert.equal(response.status, 201);
      assert.equal(first.width, 120);
      assert.equal(first.height, 80);
      assert.equal(first.sha256, undefined);
      const retry = await upload(id, photographer, image, key);
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).data.id, first.id);
      assert.equal((await upload(id, photographer, otherImage, key)).status, 409);
      assert.equal(await Photo.countDocuments({ booking: id }), 1);
      const draftRead = await call(`/bookings/${id}/delivery/photos/${first.id}`);
      assert.equal(draftRead.status, 404);
      const allowed = await call(`/bookings/${id}/delivery/photos/${first.id}`, photographer);
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('cache-control'), 'no-store');
      assert.match(allowed.headers.get('content-type'), /image\/jpeg/);
      const metadata = await sharp(Buffer.from(await allowed.arrayBuffer())).metadata();
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.format, 'jpeg');
      const thumbs = await call(
        `/bookings/${id}/delivery/photos/${first.id}?size=thumb`,
        photographer,
      );
      assert.match(thumbs.headers.get('content-type'), /image\/webp/);
    },
  );
  await t.test(
    'publication rejects duplicates/cross-booking IDs and commits one exact snapshot',
    async () => {
      const secondBooking = await make(),
        foreign = await uploadOk(secondBooking);
      assert.equal((await publish(id, [first.id, first.id])).status, 400);
      assert.equal((await publish(id, [first.id, foreign.id])).status, 409);
      assert.equal((await Workflow.findOne({ booking: id })).progress.deliveryVersion, 0);
      const key = 'publish-current-gallery-01';
      const result = await publish(id, [first.id], key);
      assert.equal(result.status, 200, await result.text());
      assert.equal((await publish(id, [first.id], key)).status, 200);
      const workflow = await Workflow.findOne({ booking: id });
      assert.equal(workflow.deliveryHistory.length, 1);
      assert.deepEqual(workflow.progress.photos.map(String), [first.id]);
      assert.deepEqual((await Photo.findById(first.id)).publishedVersions, [1]);
      const dto = await (await call(`/bookings/${id}/workflow`)).json();
      assert.equal(dto.data.workflow.progress.photos[0].id, first.id);
      assert.equal(dto.data.workflow.deliveryHistory[0].photos.length, 1);
    },
  );
  await t.test(
    'published images remain owner-private, including thumbnail and history',
    async () => {
      for (const actor of [null, other, outsider, accountant])
        assert.ok(
          [401, 403, 404].includes(
            (await call(`/bookings/${id}/delivery/photos/${first.id}`, actor)).status,
          ),
        );
      assert.equal((await call(`/bookings/${id}/delivery/photos/${first.id}`)).status, 200);
      assert.equal((await call(`/bookings/${id}/delivery/photos/${first.id}`, admin)).status, 200);
      const foreignBooking = await make();
      assert.equal(
        (await call(`/bookings/${foreignBooking}/delivery/photos/${first.id}`, admin)).status,
        404,
      );
    },
  );
  await t.test(
    'feedback reaches the studio and cannot accept a stale delivered version',
    async () => {
      assert.equal(
        (
          await action(id, client, 'revision.request', {
            note: 'Chỉnh sáng edited.png',
            deliveryVersion: 1,
          })
        ).status,
        200,
      );
      assert.equal((await Workflow.findOne({ booking: id })).lifecycle, 'revision_requested');
      const studio = await (await call(`/bookings/${id}/workflow`, photographer)).json();
      assert.equal(studio.data.workflow.progress.revisionRequests[0].note, 'Chỉnh sáng edited.png');
      assert.equal(
        (await action(id, photographer, 'progress.update', { status: 'editing' })).status,
        200,
      );
      assert.equal(
        (
          await call(
            `/bookings/${id}/delivery/photos/${first.id}`,
            photographer,
            undefined,
            'DELETE',
          )
        ).status,
        409,
      );
      const next = await uploadOk(id);
      assert.equal((await publish(id, [next.id, first.id])).status, 200);
      assert.equal(
        (await action(id, client, 'delivery.accept', { deliveryVersion: 1 })).status,
        409,
      );
      assert.equal(
        (await action(id, client, 'delivery.accept', { deliveryVersion: 2 })).status,
        200,
      );
      const workflow = await Workflow.findOne({ booking: id });
      assert.equal(workflow.progress.acceptedDeliveryVersion, 2);
      assert.equal(workflow.deliveryHistory.length, 2);
      assert.ok(workflow.progress.revisionRequests[0].resolvedAt);
      assert.equal((await call(`/bookings/${id}/delivery/photos/${first.id}`)).status, 200);
    },
  );
  await t.test(
    'deleted drafts leave tombstones, missing files cannot publish, failed persistence cleans only its own files',
    async () => {
      const booking = await make(),
        key = 'deleted-photo-upload-key';
      const response = await upload(booking, photographer, image, key);
      const photo = (await response.json()).data;
      assert.equal(
        (
          await call(
            `/bookings/${booking}/delivery/photos/${photo.id}`,
            photographer,
            undefined,
            'DELETE',
          )
        ).status,
        200,
      );
      assert.equal((await upload(booking, photographer, image, key)).status, 409);
      const missing = await uploadOk(booking);
      await fs.unlink(deliveryFile(missing.id));
      assert.equal((await publish(booking, [missing.id])).status, 409);
      const before = (await fs.readdir(directory)).sort();
      const original = Photo.create;
      Photo.create = () => {
        throw new (require('../src/services/workflowTransactions').WorkflowProblem)(
          503,
          'transaction_aborted',
        );
      };
      try {
        assert.equal((await upload(booking)).status, 503);
      } finally {
        Photo.create = original;
      }
      assert.deepEqual((await fs.readdir(directory)).sort(), before);
      Photo.create = () => {
        const error = new Error('unknown_commit_result');
        error.errorLabels = ['UnknownTransactionCommitResult'];
        throw error;
      };
      try {
        assert.equal((await upload(booking)).status, 500);
      } finally {
        Photo.create = original;
      }
      assert.equal((await fs.readdir(directory)).length, before.length + 2);
      assert.equal((await Workflow.findOne({ booking })).progress.deliveryVersion, 0);
    },
  );
  await t.test(
    'cancellation or reassignment during decoding prevents draft persistence',
    async () => {
      for (const change of ['cancelled', 'reassigned']) {
        const booking = await make();
        const original = sharp.prototype.toFile;
        sharp.prototype.toFile = async function (...args) {
          const result = await original.apply(this, args);
          if (change === 'cancelled')
            await Booking.updateOne({ _id: booking }, { $set: { status: 'cancelled' } });
          else
            await Workflow.updateOne(
              { booking },
              {
                $set: {
                  assignedPhotographer: outsider._id,
                  assignedSupportPhotographers: [],
                  'resources.photographers': [outsider._id],
                },
              },
            );
          return result;
        };
        try {
          assert.ok([404, 409].includes((await upload(booking)).status));
        } finally {
          sharp.prototype.toFile = original;
        }
        assert.equal(await Photo.countDocuments({ booking }), 0);
      }
    },
  );
  await t.test(
    'completion records a customer-visible milestone for either payment order',
    async () => {
      for (const payFirst of [true, false]) {
        const booking = await make();
        const photo = await uploadOk(booking);
        assert.equal((await publish(booking, [photo.id])).status, 200);
        const pay = () =>
          action(booking, accountant, 'payment.record', {
            kind: 'balance',
            amount: 150,
            method: 'cash',
          });
        if (payFirst) assert.equal((await pay()).status, 200);
        assert.equal(
          (await action(booking, client, 'delivery.accept', { deliveryVersion: 1 })).status,
          200,
        );
        if (!payFirst) assert.equal((await pay()).status, 200);
        const response = await call(`/bookings/${booking}/workflow`);
        const workflow = (await response.json()).data.workflow;
        assert.equal(workflow.lifecycle, 'completed');
        const milestones = workflow.events.filter((event) => event.action === 'workflow.completed');
        assert.equal(milestones.length, 1);
        assert.ok(Number.isFinite(Date.parse(milestones[0].at)));
      }
    },
  );

  await t.test('cleanup removes stale drafts but keeps every published version', async () => {
    const booking = await make(),
      photo = await uploadOk(booking),
      old = new Date(Date.now() - 8 * 86400000);
    await Photo.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(photo.id) },
      { $set: { createdAt: old } },
    );
    await Photo.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(first.id) },
      { $set: { createdAt: old } },
    );
    await fs.utimes(deliveryFile(first.id), old, old);
    await fs.utimes(deliveryFile(first.id, true), old, old);
    await fs.utimes(deliveryFile(photo.id), old, old);
    await fs.utimes(deliveryFile(photo.id, true), old, old);
    assert.equal(await cleanupDeliveryPhotos(), 2);
    assert.ok((await Photo.findById(photo.id)).deletedAt);
    await fs.stat(deliveryFile(first.id));
  });
});
