// HTTP + replica-set integration. Google HTTP is stubbed; MongoDB and authorization are real.
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
Object.assign(process.env, {
  JWT_SECRET: 'album-integration-signing-secret',
  CLIENT_PORTAL_ENABLED: 'true',
  CLIENT_WORKFLOW_ENABLED: 'true',
  EMAIL_ENABLED: 'false',
  GOOGLE_DRIVE_API_KEY: 'fixture-only-key',
});
require('ts-node/register/transpile-only');
const mongoose = require('mongoose'),
  express = require('express'),
  jwt = require('jsonwebtoken'),
  sharp = require('sharp');
const User = require('../src/models/User').default,
  Booking = require('../src/models/Booking').default,
  Workflow = require('../src/models/BookingWorkflow').default,
  Album = require('../src/models/BookingAlbum').default,
  Photo = require('../src/models/BookingAlbumPhoto').default,
  Selection = require('../src/models/BookingAlbumSelection').default;
const { parseDriveFolder, listDriveFolders } = require('../src/services/driveAlbumSource');

test('Drive albums: public selection, isolation, snapshots and workflow regression', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
  const database = `studio_drive_album_test_${process.pid}`;
  uri.pathname = '/' + database;
  await mongoose.connect(uri.toString());
  assert.equal(mongoose.connection.name, database);
  await mongoose.connection.dropDatabase();
  await Album.createIndexes();
  await Photo.createIndexes();
  await Selection.createIndexes();
  const bytes =
    process.env.ALBUM_ANNOTATION_DEMO === 'true'
      ? await sharp(path.join(__dirname, '../../frontend/src/assets/images/HDZ07441.webp'))
          .resize({ width: 960 })
          .jpeg({ quality: 85 })
          .toBuffer()
      : await sharp({
          create: { width: 96, height: 64, channels: 3, background: '#b3b8a8' },
        })
          .jpeg()
          .toBuffer();
  const md5 = createHash('md5').update(bytes).digest('hex');
  const folder = 'folder_original_001',
    edited = 'folder_edited_001',
    resourceKey = '0-resource_key_12345';
  const link = `https://drive.google.com/drive/folders/${folder}?resourcekey=${resourceKey}`;
  const files = new Map();
  const file = (id, name) => ({
    id,
    name,
    mimeType: 'image/jpeg',
    version: '1',
    md5Checksum: md5,
    size: String(bytes.length),
    imageMediaMetadata: { width: 96, height: 64 },
  });
  files.set('original_photo_001', file('original_photo_001', 'IMG_001.jpg'));
  files.set('original_photo_002', file('original_photo_002', 'IMG_002.jpg'));
  files.set('edited_photo_001', file('edited_photo_001', 'IMG_001-edited.jpg'));
  files.set('edited_photo_002', file('edited_photo_002', 'IMG_002-edited.jpg'));
  let googleStatus = 0,
    googleReason = '',
    timeout = false,
    oversized = false,
    brokenBody = false;
  let failSecondPage = false,
    includeSecond = true,
    downloadMismatch = false,
    pageCalls = 0;
  const actualFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname !== 'www.googleapis.com') return actualFetch(input, init);
    assert.equal(url.searchParams.get('key'), 'fixture-only-key');
    if (timeout) throw new Error('fixture timeout');
    if (googleStatus)
      return Response.json(
        { error: { errors: [{ reason: googleReason }] } },
        { status: googleStatus },
      );
    const id = url.pathname.split('/')[4];
    if (id === folder) {
      assert.equal(init.headers['X-Goog-Drive-Resource-Keys'], `${folder}/${resourceKey}`);
      return Response.json({
        id,
        name: 'Ảnh ban đầu',
        mimeType: 'application/vnd.google-apps.folder',
      });
    }
    if (id === edited)
      return Response.json({
        id,
        name: 'Ảnh chỉnh',
        mimeType: 'application/vnd.google-apps.folder',
      });
    if (id) {
      const meta = files.get(id);
      if (!meta) return Response.json({ error: 'removed' }, { status: 404 });
      if (url.searchParams.get('alt') === 'media' && brokenBody)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('fixture network failure'));
            },
          }),
        );
      if (url.searchParams.get('alt') === 'media')
        return new Response(downloadMismatch ? Buffer.from('bad bytes') : bytes, {
          headers: { 'Content-Type': meta.mimeType },
        });
      return Response.json({
        ...meta,
        ...(oversized ? { size: String(40 * 1024 * 1024 + 1) } : {}),
        capabilities: { canDownload: true },
      });
    }
    pageCalls++;
    if (url.searchParams.get('q').includes(edited))
      return Response.json({
        files: [files.get('edited_photo_001'), files.get('edited_photo_002')],
      });
    assert.equal(init.headers['X-Goog-Drive-Resource-Keys'], `${folder}/${resourceKey}`);
    if (url.searchParams.get('pageToken') === 'second') {
      if (failSecondPage) return Response.json({}, { status: 503 });
      return Response.json({
        files: includeSecond
          ? [
              files.get('original_photo_002'),
              { id: 'video_fixture_001', name: 'clip.mp4', mimeType: 'video/mp4' },
            ]
          : [],
      });
    }
    return Response.json({ files: [files.get('original_photo_001')], nextPageToken: 'second' });
  };
  const [admin, photographer, owner, outsider, accountant, otherOwner] = await User.create(
    [0, 3, 6, 3, 5, 6].map((role, i) => ({
      username: `album.actor.${i}`,
      name: `Actor ${i}`,
      roles: [role],
      isActive: true,
      password: 'AlbumTest123!',
    })),
  );
  const booking = await Booking.create({
    client: owner._id,
    package: new mongoose.Types.ObjectId(),
    packageName: 'Album',
    packageSnapshot: { name: 'Album', pricePerMember: 200 },
    pricePerMember: 200,
    members: 1,
    contactName: 'Private customer',
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
    progress: { status: 'editing', deliveryVersion: 0 },
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
      acceptedBy: owner._id,
      acceptedAt: new Date(),
    },
  });
  const app = express();
  app.use(require('cors')());
  app.use(express.json());
  app.use('/auth', require('../src/routes/auth').default);
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use('/public', require('../src/routes/public').default);
  app.use((err, req, res, next) => {
    if (!res.headersSent) res.status(500).json({ message: 'test_error' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    global.fetch = actualFetch;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    assert.equal(mongoose.connection.name, database);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  let sequence = 0,
    album,
    shareToken;
  const base = `/bookings/${booking._id}/album`;
  const call = (route, actor, data, token, key = `album-request-${++sequence}`) =>
    actualFetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: data ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...(actor
          ? {
              Authorization: `Bearer ${jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET)}`,
            }
          : {}),
        ...(token ? { 'X-Album-Token': token } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const ok = async (response) => {
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.data;
  };
  const staff = async (operation, data = {}, key) => {
    album = await ok(
      await call(
        `${base}/${operation}`,
        photographer,
        { ...data, expectedVersion: album?.version || 0 },
        undefined,
        key,
      ),
    );
    return album;
  };
  const publicBase = () => `/public/albums/${album.publicId}`;
  const guest = async (operation, data = {}, key) => {
    album = await ok(
      await call(
        `${publicBase()}/${operation}`,
        null,
        { ...data, expectedVersion: album.version },
        shareToken,
        key,
      ),
    );
    return album;
  };
  const act = async (action, data, actor = photographer, key) => {
    const workflow = await Workflow.findOne({ booking: booking._id });
    return call(
      `/bookings/${booking._id}/workflow/actions`,
      actor,
      { action, expectedVersion: workflow.version, ...data },
      undefined,
      key,
    );
  };

  await t.test('Drive parsing/pagination and complete sync before writes', async () => {
    assert.throws(() => parseDriveFolder('http://127.0.0.1:1234/folders/x'));
    assert.throws(() =>
      parseDriveFolder('https://drive.google.com.evil.test/drive/folders/whatever_001'),
    );
    assert.equal(parseDriveFolder(link).resourceKey, resourceKey);
    const source = await listDriveFolders([link]);
    assert.equal(source.images.length, 2);
    assert.deepEqual(source.skipped, ['clip.mp4']);
    assert.equal(pageCalls, 2);
    for (const actor of [null, outsider, accountant, otherOwner])
      assert.ok([401, 403, 404].includes((await call(base, actor)).status));
    await staff('configure', { title: 'Album lớp', limit: 1, folders: [link] });
    assert.equal(album.photos.length, 2);
    assert.equal(album.folders[0].url, link);
    failSecondPage = true;
    assert.equal(
      (await call(`${base}/sync`, photographer, { expectedVersion: album.version })).status,
      503,
    );
    assert.equal(await Photo.countDocuments({ available: true }), 2);
    failSecondPage = false;
    await staff('share', {}, 'share-retry-same-key');
    assert.equal(await ok(await call(base, owner)), null);
    shareToken = album.token;
    const again = await ok(
      await call(
        `${base}/share`,
        photographer,
        { expectedVersion: album.version - 1 },
        null,
        'share-retry-same-key',
      ),
    );
    assert.equal(again.token, shareToken);
    assert.equal((await call(publicBase(), null, undefined, shareToken)).status, 404);
    await staff('publish');
  });
  await t.test(
    'booking owner uses the same selection without a share token; draft and staff tools stay private',
    async () => {
      const view = await ok(await call(base, owner));
      assert.equal(view.publicId, album.publicId);
      for (const field of ['token', 'shared', 'workflowVersion', 'skipped', 'selectionHistory'])
        assert.equal(view[field], undefined);
      const photo = view.photos[0];
      const payload = { expectedVersion: view.version, photoId: photo.id, selected: true };
      const selected = await ok(
        await call(`${base}/photo`, owner, payload, undefined, 'owner-select-retry-key'),
      );
      const again = await ok(
        await call(`${base}/photo`, owner, payload, undefined, 'owner-select-retry-key'),
      );
      assert.equal(again.version, selected.version);
      const guestView = await ok(await call(publicBase(), null, undefined, shareToken));
      assert.equal(guestView.photos.find((p) => p.id === photo.id).selected, true);
      for (const operation of ['configure', 'share', 'revoke', 'delivery-sync'])
        assert.equal(
          (await call(`${base}/${operation}`, owner, { expectedVersion: selected.version })).status,
          404,
        );
      assert.equal((await call(`${base}/export/names`, owner)).status, 404);
      assert.equal((await call(`${base}/photos/${photo.id}`, otherOwner)).status, 404);
      assert.equal(
        (
          await call(`${base}/photo`, otherOwner, {
            expectedVersion: selected.version,
            photoId: photo.id,
            selected: false,
          })
        ).status,
        404,
      );
      assert.equal((await call(`${base}/photos/${photo.id}?size=thumb`, owner)).status, 200);
      album = await ok(
        await call(`${base}/photo`, owner, {
          expectedVersion: selected.version,
          photoId: photo.id,
          selected: false,
        }),
      );
    },
  );
  await t.test('public DTO, token isolation and image proxy', async () => {
    album = await ok(await call(publicBase(), null, undefined, shareToken));
    for (const key of [
      'booking',
      'phone',
      'payments',
      'workflowVersion',
      'selectionHistory',
      'tokenHash',
      'skipped',
    ])
      assert.equal(album[key], undefined);
    assert.equal((await call(publicBase(), null, undefined, 'x'.repeat(43))).status, 404);
    assert.equal(
      (
        await call(
          `${publicBase()}/photos/${new mongoose.Types.ObjectId()}`,
          null,
          undefined,
          shareToken,
        )
      ).status,
      404,
    );
    const response = await call(
      `${publicBase()}/photos/${album.photos[0].id}?size=thumb`,
      null,
      undefined,
      shareToken,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(
      (await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format,
      'webp',
    );
    downloadMismatch = true;
    assert.equal(
      (await call(`${publicBase()}/photos/${album.photos[0].id}`, null, undefined, shareToken))
        .status,
      409,
    );
    downloadMismatch = false;
  });
  await t.test('concurrent devices, limits, notes and idempotent set', async () => {
    const version = album.version;
    const responses = await Promise.all(
      album.photos.map((p) =>
        call(
          `${publicBase()}/photo`,
          null,
          { expectedVersion: version, photoId: p.id, selected: true },
          shareToken,
        ),
      ),
    );
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    album = await ok(await call(publicBase(), null, undefined, shareToken));
    const first = album.photos.find((p) => p.selected),
      second = album.photos.find((p) => !p.selected);
    assert.equal(
      (
        await call(
          `${publicBase()}/photo`,
          null,
          { expectedVersion: album.version, photoId: second.id, selected: true },
          shareToken,
        )
      ).status,
      409,
    );
    const payload = {
      expectedVersion: album.version,
      photoId: first.id,
      note: 'Làm sáng khuôn mặt',
    };
    album = await ok(
      await call(`${publicBase()}/photo`, null, payload, shareToken, 'note-retry-same-key'),
    );
    const retry = await ok(
      await call(`${publicBase()}/photo`, null, payload, shareToken, 'note-retry-same-key'),
    );
    assert.equal(retry.version, album.version);
    assert.equal(
      (
        await call(
          `${publicBase()}/photo`,
          null,
          { ...payload, note: 'different' },
          shareToken,
          'note-retry-same-key',
        )
      ).status,
      409,
    );
    await staff('sync');
    assert.equal(album.photos.find((p) => p.id === first.id).note, 'Làm sáng khuôn mặt');
    const exported = await ok(await call(`${base}/export/names?extension=false`, photographer));
    assert.equal(exported.names.length, 1);
    assert.ok(!exported.text.endsWith('.jpg'));
  });
  await t.test('missing API key, Drive quotas, interrupted downloads and size limits', async () => {
    delete process.env.GOOGLE_DRIVE_API_KEY;
    await assert.rejects(
      () => listDriveFolders([link]),
      (e) => e.status === 503,
    );
    process.env.GOOGLE_DRIVE_API_KEY = 'fixture-only-key';
    googleStatus = 429;
    await assert.rejects(
      () => listDriveFolders([link]),
      (e) => e.status === 503,
    );
    googleStatus = 403;
    googleReason = 'downloadQuotaExceeded';
    await assert.rejects(
      () => listDriveFolders([link]),
      (e) => e.status === 503,
    );
    googleStatus = 0;
    timeout = true;
    await assert.rejects(
      () => listDriveFolders([link]),
      (e) => e.status === 503,
    );
    timeout = false;
    oversized = true;
    assert.equal(
      (await call(`${publicBase()}/photos/${album.photos[0].id}`, null, undefined, shareToken))
        .status,
      413,
    );
    oversized = false;
    brokenBody = true;
    assert.equal(
      (await call(`${publicBase()}/photos/${album.photos[0].id}`, null, undefined, shareToken))
        .status,
      503,
    );
    brokenBody = false;
  });
  await t.test('finalize snapshot and retry, lock, reopen and missing source', async () => {
    const payload = { expectedVersion: album.version };
    album = await ok(
      await call(`${publicBase()}/finalize`, null, payload, shareToken, 'finalize-retry-same-key'),
    );
    assert.equal(album.status, 'closed');
    assert.equal(
      (await call(`${publicBase()}/finalize`, null, payload, shareToken, 'finalize-retry-same-key'))
        .status,
      200,
    );
    assert.equal((await Album.findOne()).selectionHistory.length, 1);
    assert.equal((await Selection.findOne({ round: 1 })).note, 'Làm sáng khuôn mặt');
    const frozen = await ok(await call(`${base}/export/names?round=1`, photographer));
    assert.equal(frozen.names.length, 1);
    assert.equal(
      (
        await call(
          `${publicBase()}/photo`,
          null,
          { expectedVersion: album.version, photoId: album.photos[0].id, selected: false },
          shareToken,
        )
      ).status,
      409,
    );
    await staff('reopen');
    includeSecond = false;
    await staff('sync');
    assert.equal(album.photos.find((p) => p.driveId === 'original_photo_002').available, false);
    includeSecond = true;
    await staff('sync');
    album = await ok(await call(`${base}/finalize`, owner, { expectedVersion: album.version }));
    assert.equal(
      (await ok(await call(publicBase(), null, undefined, shareToken))).status,
      'closed',
    );
  });
  await t.test('edited drafts hidden, versioned publish and retained delivery', async () => {
    await staff('delivery-sync', { folders: [`https://drive.google.com/drive/folders/${edited}`] });
    const draft = album.photos.find((p) => p.deliveryVersion === -1);
    assert.equal((await call(`${base}/photos/${draft.id}`, owner)).status, 404);
    const guestView = await ok(await call(publicBase(), null, undefined, shareToken));
    assert.ok(!guestView.photos.some((p) => p.id === draft.id));
    assert.equal(
      (await call(`${publicBase()}/photos/${draft.id}`, null, undefined, shareToken)).status,
      404,
    );
    const delivered = await ok(
      await act(
        'progress.update',
        { status: 'delivered', driveAlbum: true, albumVersion: album.version },
        photographer,
        'delivery-replay-same-key',
      ),
    );
    assert.equal(delivered.workflow.progress.deliveryVersion, 1);
    const image = delivered.workflow.progress.photos[0];
    assert.equal(image.source, 'drive');
    assert.match(image.id, /^drive-/);
    const read = await call(`/bookings/${booking._id}/delivery/photos/${image.id}`, owner);
    assert.equal(read.status, 200);
    const retry = await ok(
      await act(
        'progress.update',
        { status: 'delivered', driveAlbum: true, albumVersion: album.version },
        photographer,
        'delivery-replay-same-key',
      ),
    );
    assert.equal(retry.workflow.progress.deliveryVersion, 1);
    album = await ok(await call(publicBase(), null, undefined, shareToken));
    const editedPhoto = album.photos.find((p) => p.deliveryVersion === 1);
    await guest('photo', { photoId: editedPhoto.id, note: 'Thêm sáng một chút' });
    assert.equal((await Workflow.findOne()).lifecycle, 'delivered');
    assert.ok(
      [401, 403].includes(
        (
          await call(
            `/bookings/${booking._id}/workflow/actions`,
            null,
            { action: 'delivery.accept', expectedVersion: 0, deliveryVersion: 1 },
            shareToken,
          )
        ).status,
      ),
    );
    await ok(
      await act('delivery.revision.start', { deliveryVersion: 1, note: 'Xử lý góp ý của khách' }),
    );
    await ok(await act('progress.update', { status: 'editing' }));
    album = await ok(await call(base, photographer));
    files.get('edited_photo_001').md5Checksum = 'changed-source';
    assert.equal(
      (
        await act('progress.update', {
          status: 'delivered',
          driveAlbum: true,
          albumVersion: album.version,
        })
      ).status,
      409,
    );
    assert.equal(
      (await call(`${publicBase()}/photos/${editedPhoto.id}`, null, undefined, shareToken)).status,
      409,
    );
    files.get('edited_photo_001').md5Checksum = md5;
    await ok(
      await act('progress.update', {
        status: 'delivered',
        driveAlbum: true,
        albumVersion: album.version,
      }),
    );
    album = await ok(await call(publicBase(), null, undefined, shareToken));
    assert.equal(album.deliveryVersions.length, 2);
    assert.equal(
      (
        await call(
          `${publicBase()}/photo`,
          null,
          { expectedVersion: album.version, photoId: editedPhoto.id, note: 'old version' },
          shareToken,
        )
      ).status,
      409,
    );
    const accepted = await ok(await act('delivery.accept', { deliveryVersion: 2 }, owner));
    assert.equal(accepted.workflow.lifecycle, 'accepted');
    assert.equal(accepted.workflow.deliveryHistory.length, 2);
  });
  await t.test('revoke/rotate, reassignment, cancellation and feature switch', async () => {
    album = await ok(await call(base, photographer));
    await staff('revoke');
    assert.equal((await call(publicBase(), null, undefined, shareToken)).status, 404);
    await staff('share');
    const previous = shareToken;
    shareToken = album.token;
    assert.notEqual(previous, shareToken);
    assert.equal((await call(publicBase(), null, undefined, previous)).status, 404);
    await Workflow.updateOne(
      { booking: booking._id },
      { $set: { assignedPhotographer: outsider._id, 'resources.photographers': [outsider._id] } },
    );
    assert.equal((await call(base, photographer)).status, 404);
    await Booking.updateOne({ _id: booking._id }, { $set: { status: 'cancelled' } });
    assert.equal((await call(publicBase(), null, undefined, shareToken)).status, 404);
    process.env.CLIENT_PORTAL_ENABLED = 'false';
    assert.equal((await call(publicBase(), null, undefined, shareToken)).status, 503);
    process.env.CLIENT_PORTAL_ENABLED = 'true';
  });
  if (process.env.ALBUM_BROWSER_TEST === 'true')
    await t.test('browser desktop/mobile end-to-end with real album HTTP', async () => {
      const browserBooking = await Booking.create({
        ...booking.toObject(),
        _id: new mongoose.Types.ObjectId(),
        status: 'approved',
      });
      const original = await Workflow.findOne({ booking: booking._id });
      await Workflow.create({
        ...original.toObject(),
        _id: new mongoose.Types.ObjectId(),
        booking: browserBooking._id,
        lifecycle: 'editing',
        version: 0,
        assignedPhotographer: photographer._id,
        resources: { ...original.resources.toObject(), photographers: [photographer._id] },
        progress: { status: 'editing', deliveryVersion: 0, revisionRequests: [] },
        deliveryHistory: [],
        events: [],
        idempotency: [],
      });
      await require('../../ops/tests/booking-album-browser.cjs')({
        bookingId: String(browserBooking._id),
        photographer,
        jwtToken: jwt.sign({ id: String(photographer._id) }, process.env.JWT_SECRET),
        apiOrigin: `http://127.0.0.1:${server.address().port}`,
        sourceLink: link,
        editedLink: `https://drive.google.com/drive/folders/${edited}`,
        owner,
        ownerToken: jwt.sign({ id: String(owner._id) }, process.env.JWT_SECRET),
      });
    });
});
