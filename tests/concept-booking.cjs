const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac, createHash, randomUUID } = require('node:crypto');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
Object.assign(process.env, {
  CONCEPT_BOOKING_ENABLED: 'true',
  CLIENT_PORTAL_ENABLED: 'true',
  CLIENT_WORKFLOW_ENABLED: 'true',
  JWT_SECRET: 'concept-test-signing-secret-long',
  SEPAY_ENABLED: 'true',
  SEPAY_MODE: 'sandbox',
  SEPAY_WEBHOOK_SECRET: 'concept-webhook-secret-at-least-32-characters',
  PAYMENT_BANK_CODE: 'MB',
  SEPAY_BANK_GATEWAY: 'MBBank',
  PAYMENT_BANK_NAME: 'MBBank',
  PAYMENT_ACCOUNT_NAME: 'YUME STUDIO',
  PAYMENT_ACCOUNT_NUMBER: '123456789',
  EMAIL_ENABLED: 'false',
  GOOGLE_DRIVE_API_KEY: 'concept-fixture-only',
});
require('ts-node/register/transpile-only');
const mongoose = require('mongoose'),
  express = require('express'),
  jwt = require('jsonwebtoken');
const { cancellationAmounts, canReschedule, HOUR } = require('../src/services/conceptPolicy');
test('concept cancellation boundaries, original-date protection and one reschedule', () => {
  const now = Date.now();
  const order = {
    status: 'confirmed',
    startAt: new Date(now + 60 * HOUR),
    originalStartAt: new Date(now + 60 * HOUR),
    snapshot: { deposit: 300000 },
    payments: [
      { kind: 'deposit', amount: 300000 },
      { kind: 'balance', amount: 700000 },
    ],
    rescheduleCount: 0,
  };
  for (const [hours, retained] of [
    [48, 0],
    [47.99, 150000],
    [24, 150000],
    [23.99, 300000],
  ]) {
    order.originalStartAt = new Date(now + hours * HOUR);
    assert.deepEqual(cancellationAmounts(order, now), { retained, refundDue: 1000000 - retained });
  }
  assert.equal(canReschedule(order, now), true);
  order.rescheduleCount = 1;
  assert.equal(canReschedule(order, now), false);
  order.rescheduleCount = 0;
  order.startAt = new Date(now + 48 * HOUR - 1);
  assert.equal(canReschedule(order, now), false);
  order.startAt = new Date(now);
  assert.throws(() => cancellationAmounts(order, now));
});

test('concept HTTP, shared resources, SePay, operations and Drive album', async (t) => {
  assert.ok(process.env.MONGO_TEST_URI, 'Run with node ops/run-concept-tests.cjs');
  const uri = new URL(process.env.MONGO_TEST_URI);
  assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
  const database = `studio_sepay_concept_test_${process.pid}`;
  uri.pathname = '/' + database;
  process.env.SEPAY_SANDBOX_DATABASE = database;
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 3000 });
  assert.equal(mongoose.connection.name, database);
  await mongoose.connection.dropDatabase();
  const User = require('../src/models/User').default,
    Concept = require('../src/models/Concept').default,
    Package = require('../src/models/ConceptPackage').default,
    Profile = require('../src/models/PhotographerProfile').default,
    Order = require('../src/models/ConceptOrder').default,
    Album = require('../src/models/ConceptAlbum').default,
    Photo = require('../src/models/ConceptPhoto').default,
    Costume = require('../src/models/Costume').default,
    CostumeType = require('../src/models/CostumeType').default,
    Schedule = require('../src/models/Schedule').default,
    Transaction = require('../src/models/Transaction').default,
    Receipt = require('../src/models/SePayReceipt').default,
    Booking = require('../src/models/Booking').default,
    Workflow = require('../src/models/BookingWorkflow').default,
    Rental = require('../src/models/RentalOrder').default;
  for (const model of [
    User,
    Concept,
    Package,
    Profile,
    Order,
    Album,
    Photo,
    Schedule,
    Transaction,
    Receipt,
    Booking,
    Workflow,
    Rental,
  ])
    await model.init();
  const actors = {};
  for (const [key, role] of [
    ['admin', 0],
    ['client', 6],
    ['other', 6],
    ['photo', 3],
    ['photo2', 3],
    ['sale', 2],
    ['account', 5],
    ['unverified', 6],
  ]) {
    actors[key] = await User.create({
      username: 'concept.' + key,
      name: key,
      password: 'TestOnly123!',
      roles: [role],
      email: `${key}@example.com`,
      ...(key !== 'unverified' ? { emailVerifiedAt: new Date() } : {}),
      isActive: true,
    });
  }
  const concept = await Concept.create({ name: 'Nàng thơ', description: 'Concept test' });
  const type = await CostumeType.create({ name: 'Áo dài' });
  const costume = await Costume.create({
    name: 'Áo dài trắng',
    type: type._id,
    itemKind: 'clothing',
    gender: 'unisex',
    isRentalItem: true,
    rentalPrice: 100000,
    inventory: [{ size: 'M', quantity: 1, condition: 'good' }],
  });
  const pkg = await Package.create({
    concept: concept._id,
    name: 'Gói riêng',
    decor: {
      backdrop: 'Phông kem',
      props: 'Ghế gỗ',
      layout: 'Góc cửa sổ',
      included: 'Một set decor studio',
    },
    price: 1000000,
    durationMinutes: 60,
    maxPeople: 2,
    retouchQuota: 1,
    extraPhotoPrice: 50000,
    costumeCount: 1,
    costumeTypes: [type._id],
  });
  for (const key of ['photo', 'photo2'])
    await Profile.create({
      photographer: actors[key]._id,
      concepts: [concept._id],
      bio: key,
      published: true,
      portfolio: [],
    });
  const app = express();
  app.use('/api/payments', require('../src/routes/payments').default);
  app.use(express.json());
  app.use('/api/concepts', require('../src/routes/concepts').default);
  app.use('/api/concept-orders', require('../src/routes/conceptOrders').default);
  app.use('/api/public/concept-albums', require('../src/routes/conceptOrders').publicConceptAlbums);
  app.use('/api/auth', require('../src/routes/auth').default);
  app.use('/api/bookings', require('../src/routes/bookings').default);
  app.use('/api/schedules', require('../src/routes/schedules').default);
  app.use('/api/transactions', require('../src/routes/transactions').default);
  app.use((e, _q, r, _n) => {
    console.error(e);
    r.status(500).json({ message: e.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const realFetch = global.fetch;
  const bytes = await require('sharp')({
    create: { width: 80, height: 60, channels: 3, background: '#abc' },
  })
    .jpeg()
    .toBuffer();
  const checksum = createHash('md5').update(bytes).digest('hex');
  let sourceVersion = '1';
  let includeSecond = true;
  const metadata = (id, name) => ({
    id,
    name,
    mimeType: 'image/jpeg',
    version: sourceVersion,
    md5Checksum: checksum,
    size: String(bytes.length),
    imageMediaMetadata: { width: 80, height: 60 },
  });
  global.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname !== 'www.googleapis.com') return realFetch(input, init);
    const id = url.pathname.split('/')[4];
    if (url.searchParams.get('alt') === 'media')
      return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
    if (id?.startsWith('folder_'))
      return Response.json({
        id,
        name: id,
        mimeType: 'application/vnd.google-apps.folder',
        version: '1',
      });
    if (!id) {
      const edited = url.searchParams.get('q').includes('retouch');
      return Response.json({
        files: [
          metadata(edited ? 'retouch_photo_001' : 'color_photo_001', 'IMG_001.jpg'),
          metadata(edited ? 'retouch_photo_002' : 'color_photo_002', 'IMG_002.jpg'),
        ].filter((_, index) => includeSecond || index === 0),
      });
    }
    return Response.json(metadata(id, id.endsWith('001') ? 'IMG_001.jpg' : 'IMG_002.jpg'));
  };
  t.after(async () => {
    global.fetch = realFetch;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    assert.equal(mongoose.connection.name, database);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  const token = (actor) => jwt.sign({ id: String(actors[actor]._id) }, process.env.JWT_SECRET);
  const request = async (method, route, actor = 'client', body, key = randomUUID()) => {
    const response = await realFetch(base + route, {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${token(actor)}` } : {}),
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (response.headers.get('content-type') || '').includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: data };
  };
  const future = (offset = 4, hour = 10) => {
    const date = new Date(Date.now() + offset * 86400000 + 7 * HOUR).toISOString().slice(0, 10);
    return `${date}T${String(hour).padStart(2, '0')}:00:00+07:00`;
  };
  const body = (start = future(), photo = 'photo', withCostume = true) => ({
    packageId: String(pkg._id),
    packageVersion: 0,
    accepted: true,
    startAt: start,
    photographerId: String(actors[photo]._id),
    costumes: withCostume ? [{ costumeId: String(costume._id), size: 'M', quantity: 1 }] : [],
    contactName: 'Khách',
    phone: '0901234567',
    people: 1,
    brief: 'Nàng thơ',
    references: [],
  });
  const make = async (start = future(), actor = 'client', photo = 'photo', withCostume = true) => {
    const r = await request('POST', '/concept-orders', actor, body(start, photo, withCostume));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  let receiptId = 100;
  const pay = async (orderId, kind, amount, overrides = {}) => {
    const order = await Order.findById(orderId);
    const p = [...order.paymentRequests]
      .reverse()
      .find((p) => p.kind === kind && p.status === 'pending');
    assert.ok(p, kind);
    const payload = {
      id: ++receiptId,
      gateway: 'MBBank',
      accountNumber: '123456789',
      content: p.reference,
      code: p.reference,
      transferType: 'in',
      transferAmount: amount ?? p.amount - p.received,
      transactionDate: new Date(Math.max(Date.now(), +p.createdAt) + 7 * HOUR)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' '),
      referenceCode: 'CONCEPT-TEST-' + receiptId,
      ...overrides,
    };
    const raw = JSON.stringify(payload),
      stamp = String(Math.floor(Date.now() / 1000));
    const signature =
      'sha256=' +
      createHmac('sha256', process.env.SEPAY_WEBHOOK_SECRET)
        .update(stamp + '.' + raw)
        .digest('hex');
    const response = await realFetch(base + '/payments/sepay/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SePay-Timestamp': stamp,
        'X-SePay-Signature': signature,
      },
      body: raw,
    });
    assert.equal(response.status, 200, await response.text());
    return payload;
  };
  const command = async (id, op, b = {}, actor = 'client', key = randomUUID()) => {
    const doc = await Order.findById(id);
    return request(
      'POST',
      `/concept-orders/${id}/${op}`,
      actor,
      { ...b, expectedVersion: doc.version },
      key,
    );
  };
  const albumCommand = async (id, op, b = {}, actor = 'client', key = randomUUID()) => {
    const doc = await Album.findOne({ order: id });
    return request(
      'POST',
      `/concept-orders/${id}/album/${op}`,
      actor,
      { ...b, expectedVersion: doc?.version || 0 },
      key,
    );
  };
  let first;
  await t.test(
    'concept detail content is public, validated and preserved on legacy edits',
    async () => {
      const input = {
        id: String(concept._id),
        name: concept.name,
        description: 'Concept test',
        coverUrl: '/images/concepts/portrait-01.webp',
        active: true,
        story: 'Câu chuyện và phong cách.',
        styleSummary: 'Ánh sáng mềm',
        audience: 'Chân dung cá nhân',
        setting: 'Studio',
        wardrobeGuidance: 'Tông màu trung tính',
        preparation: 'Chuẩn bị trang phục.',
        gallery: [{ url: '/images/concepts/portrait-02.webp', caption: 'Ánh sáng cửa sổ' }],
      };
      assert.equal((await request('POST', '/concepts/concept', 'client', input)).status, 403);
      assert.equal((await request('POST', '/concepts/concept', 'admin', input)).status, 200);
      let publicCatalog = (await request('GET', '/concepts', null)).body.data;
      let saved = publicCatalog.concepts.find((item) => String(item._id) === String(concept._id));
      assert.equal(saved.story, input.story);
      assert.equal(saved.gallery[0].url, input.gallery[0].url);
      const legacy = {
        id: input.id,
        name: input.name,
        description: input.description,
        coverUrl: input.coverUrl,
        active: true,
      };
      assert.equal((await request('POST', '/concepts/concept', 'admin', legacy)).status, 200);
      for (const url of [
        '/images/concepts/../secret.webp',
        'javascript:alert(1)',
        'http://example.com/photo.jpg',
      ])
        assert.equal(
          (await request('POST', '/concepts/concept', 'admin', { ...input, gallery: [{ url }] }))
            .status,
          400,
        );
      assert.equal(
        (
          await request('POST', '/concepts/concept', 'admin', {
            ...input,
            gallery: Array.from({ length: 25 }, () => input.gallery[0]),
          })
        ).status,
        400,
      );
      publicCatalog = (await request('GET', '/concepts', null)).body.data;
      saved = publicCatalog.concepts.find((item) => String(item._id) === input.id);
      assert.equal(saved.story, input.story);
      assert.equal(saved.gallery.length, 1);
    },
  );

  await t.test('catalog management, public profiles, verified email and empty days', async () => {
    assert.equal((await request('GET', '/concepts', '')).status, 200);
    assert.equal((await request('GET', '/concepts/manage', 'client')).status, 403);
    assert.equal((await request('POST', '/concept-orders', 'unverified', body())).status, 403);
    const r = await request(
      'GET',
      `/concepts/availability?packageId=${pkg._id}&day=${future().slice(0, 10)}`,
      '',
    );
    assert.equal(r.status, 200);
    assert.ok(r.body.data.slots.length);
    assert.ok(!JSON.stringify(r.body).includes('schedules'));
    const key = randomUUID();
    const input = { name: 'Gia đình', description: 'Chụp gia đình', active: true };
    assert.equal((await request('POST', '/concepts/concept', 'admin', input, key)).status, 200);
    assert.equal((await request('POST', '/concepts/concept', 'admin', input, key)).status, 200);
    assert.equal(await Concept.countDocuments({ name: 'Gia đình' }), 1);
    assert.equal(
      (await request('POST', '/concepts/concept', 'admin', { ...input, name: 'Tên khác' }, key))
        .status,
      409,
    );
    assert.equal(
      (
        await request('POST', '/concepts/package', 'admin', {
          ...pkg.toObject(),
          id: String(pkg._id),
          concept: String(concept._id),
          costumeTypes: [String(type._id)],
          expectedVersion: 99,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request('POST', '/concepts/profile', 'admin', {
          photographer: String(actors.photo._id),
          concepts: [String(concept._id)],
          published: true,
          bio: 'Thợ',
          portfolio: [
            {
              concept: String(concept._id),
              url: 'https://example.com/image.jpg',
              caption: 'Ảnh',
              permitted: false,
            },
          ],
        })
      ).status,
      400,
    );
  });
  await t.test(
    'personal photographer profiles are validated, public-only and legacy compatible',
    async () => {
      const doc = await Profile.findOne({ photographer: actors.photo._id });
      const baseProfile = {
        id: String(doc._id),
        photographer: String(actors.photo._id),
        concepts: [String(concept._id)],
        bio: 'Giới thiệu ngắn',
        published: true,
        portfolio: [
          {
            concept: String(concept._id),
            url: '/images/concepts/portrait-01.webp',
            caption: 'Ánh sáng mềm',
            permitted: true,
          },
        ],
      };
      const content = {
        portraitUrl: '/images/concepts/photographer-minh-duc.webp',
        coverUrl: '/images/concepts/portrait-01.webp',
        title: 'Chân dung và áo dài',
        tagline: 'Giữ nét riêng.',
        story: 'Tôi thích ánh sáng tự nhiên.',
        specialty: 'Chân dung',
        style: 'Tông ấm',
        guidance: 'Nhẹ nhàng',
        philosophy: 'Biểu cảm riêng của bạn.',
        approach: [{ title: 'Làm quen', description: 'Trao đổi trước khi chụp.' }],
        audience: [{ title: 'Lần đầu chụp', description: 'Được hướng dẫn cụ thể.' }],
        milestones: [],
      };
      assert.equal(
        (await request('POST', '/concepts/profile', 'photo', { ...baseProfile, ...content }))
          .status,
        403,
      );
      assert.equal(
        (await request('POST', '/concepts/profile', 'admin', { ...baseProfile, ...content }))
          .status,
        200,
      );
      const url = `/concepts/photographers/${actors.photo._id}`;
      let result = await request('GET', url, '');
      assert.equal(result.status, 200);
      for (const [field, value] of Object.entries(content))
        assert.deepEqual(result.body.data[field], value);
      assert.equal(result.body.data.portfolio.length, 1);
      for (const privateField of ['email', 'phone', 'password', 'roles', 'published', 'createdAt'])
        assert.equal(privateField in result.body.data, false);
      assert.equal((await request('POST', '/concepts/profile', 'admin', baseProfile)).status, 200);
      result = await request('GET', url, '');
      for (const [field, value] of Object.entries(content))
        assert.deepEqual(result.body.data[field], value);
      for (const invalid of [
        { title: 'x'.repeat(121) },
        { story: 'x'.repeat(4001) },
        { portraitUrl: 'javascript:alert(1)' },
        { coverUrl: '/images/concepts/../private.webp' },
        { approach: Array(5).fill(content.approach[0]) },
        { audience: null },
        { milestones: [{ title: '', description: 'Missing title' }] },
        { portfolio: [{ ...baseProfile.portfolio[0], permitted: false }] },
      ])
        assert.equal(
          (await request('POST', '/concepts/profile', 'admin', { ...baseProfile, ...invalid }))
            .status,
          400,
        );
      const hidden = await Concept.create({ name: 'Không công khai', active: false });
      await Profile.updateOne(
        { _id: doc._id },
        {
          $addToSet: { concepts: hidden._id },
          $push: {
            portfolio: {
              $each: [
                { concept: concept._id, url: 'https://example.com/private.jpg', permitted: false },
                { concept: hidden._id, url: 'https://example.com/hidden.jpg', permitted: true },
              ],
            },
          },
        },
      );
      result = await request('GET', url, '');
      assert.equal(result.body.data.portfolio.length, 1);
      assert.equal(result.body.data.concepts.length, 1);
      await Profile.updateOne({ _id: doc._id }, { $set: { published: false } });
      assert.equal((await request('GET', url, '')).status, 404);
      await Profile.updateOne({ _id: doc._id }, { $set: { published: true } });
      await User.updateOne({ _id: actors.photo._id }, { $set: { isActive: false } });
      assert.equal((await request('GET', url, '')).status, 404);
      await User.updateOne({ _id: actors.photo._id }, { $set: { isActive: true } });
      assert.equal((await request('GET', '/concepts/photographers/invalid-id', '')).status, 400);
      assert.equal(
        (await request('GET', `/concepts/photographers/${actors.client._id}`, '')).status,
        404,
      );
    },
  );
  await t.test('package presentation validates, persists and survives legacy edits', async () => {
    const decor = {
      backdrop: 'Phông pastel',
      props: 'Hoa và ghế gỗ',
      layout: 'Góc ngồi và đứng',
      included: 'Một set decor',
    };
    const input = {
      concept: String(concept._id),
      name: 'Gói bối cảnh',
      price: 900000,
      durationMinutes: 60,
      maxPeople: 1,
      retouchQuota: 10,
      extraPhotoPrice: 70000,
      costumeTypes: [],
      costumeCount: 0,
      active: true,
      decor,
      introduction: 'Một bộ ảnh mang nét riêng của bạn.',
      studioSupport: [
        { title: 'Hướng dẫn tạo dáng', description: 'Ekip hỗ trợ trong suốt buổi chụp.' },
      ],
      delivery: {
        timeline: 'Bảy ngày sau khi chốt ảnh.',
        format: 'JPEG qua album riêng.',
        originals: 'Theo thỏa thuận.',
      },
      showcase: {
        title: 'Trước và sau hậu kỳ',
        description: 'Cùng một khung hình.',
        images: [
          { url: '/images/concepts/portrait-01.webp', caption: 'Trước hậu kỳ' },
          { url: 'https://example.com/after.jpg', caption: 'Sau hậu kỳ' },
        ],
      },
    };
    assert.equal((await request('POST', '/concepts/package', 'client', input)).status, 403);
    assert.equal((await request('POST', '/concepts/package', 'admin', input)).status, 200);
    let saved = await Package.findOne({ name: input.name }).lean();
    const catalog = (await request('GET', '/concepts', null)).body.data;
    assert.deepEqual(
      catalog.packages.find((row) => String(row._id) === String(saved._id)).decor,
      decor,
    );
    const publicPackage = catalog.packages.find((row) => String(row._id) === String(saved._id));
    for (const field of ['introduction', 'studioSupport', 'delivery', 'showcase'])
      assert.deepEqual(publicPackage[field], input[field]);
    const legacy = {
      ...input,
      id: String(saved._id),
      expectedVersion: saved.version,
      active: false,
    };
    delete legacy.decor;
    for (const field of ['introduction', 'studioSupport', 'delivery', 'showcase'])
      delete legacy[field];
    assert.equal((await request('POST', '/concepts/package', 'admin', legacy)).status, 200);
    saved = await Package.findById(saved._id).lean();
    assert.deepEqual(saved.decor, decor);
    for (const field of ['introduction', 'studioSupport', 'delivery', 'showcase'])
      assert.deepEqual(saved[field], input[field]);
    for (const invalid of [null, [], { backdrop: 'x'.repeat(1001) }])
      assert.equal(
        (
          await request('POST', '/concepts/package', 'admin', {
            ...legacy,
            expectedVersion: saved.version,
            decor: invalid,
          })
        ).status,
        400,
      );
    assert.deepEqual((await Package.findById(saved._id).lean()).decor, decor);
    for (const invalid of [
      { introduction: 'x'.repeat(1001) },
      { studioSupport: Array(5).fill(input.studioSupport[0]) },
      { studioSupport: [{ title: '', description: 'Thiếu tiêu đề' }] },
      { delivery: null },
      { delivery: [] },
      { delivery: { format: 'x'.repeat(1001) } },
      { showcase: null },
      { showcase: { images: Array(7).fill(input.showcase.images[0]) } },
      { showcase: { images: [{ url: 'javascript:alert(1)' }] } },
      { showcase: { images: [{ url: '/images/concepts/../private.webp' }] } },
    ])
      assert.equal(
        (
          await request('POST', '/concepts/package', 'admin', {
            ...legacy,
            expectedVersion: saved.version,
            ...invalid,
          })
        ).status,
        400,
      );
    const unchanged = await Package.findById(saved._id).lean();
    assert.equal(unchanged.version, saved.version);
    for (const field of ['introduction', 'studioSupport', 'delivery', 'showcase'])
      assert.deepEqual(unchanged[field], input[field]);
  });

  await t.test(
    'included wardrobe accepts measurements, validates each person and preserves legacy inventory',
    async () => {
      actors.measurements = await User.create({
        username: 'concept.measurements',
        name: 'Khách số đo',
        password: 'TestOnly123!',
        roles: [6],
        email: 'measurements@example.com',
        emailVerifiedAt: new Date(),
        isActive: true,
      });
      const input = {
        ...body(future(40), 'photo', false),
        wardrobeMeasurements: [{ size: 'M', heightCm: 165.5, weightKg: 55.2 }],
      };
      delete input.costumes;
      for (const invalid of [
        null,
        [],
        [{ size: '', heightCm: 165, weightKg: 55 }],
        [{ size: 'M', heightCm: '165', weightKg: 55 }],
        [{ size: 'M', heightCm: 0, weightKg: 55 }],
        [{ size: 'M', heightCm: 251, weightKg: 55 }],
        [{ size: 'M', heightCm: 165, weightKg: -1 }],
        [null],
        [...input.wardrobeMeasurements, ...input.wardrobeMeasurements],
      ])
        assert.equal(
          (
            await request('POST', '/concept-orders', 'measurements', {
              ...input,
              wardrobeMeasurements: invalid,
            })
          ).status,
          400,
        );
      assert.equal(
        (
          await request('POST', '/concept-orders', 'measurements', {
            ...input,
            costumes: body().costumes,
          })
        ).status,
        400,
      );
      const key = randomUUID();
      const created = await request('POST', '/concept-orders', 'measurements', input, key);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const order = created.body.data;
      assert.deepEqual(order.wardrobeMeasurements, input.wardrobeMeasurements);
      assert.deepEqual(order.costumes, []);
      assert.equal(
        (await request('POST', '/concept-orders', 'measurements', input, key)).body.data._id,
        order._id,
      );
      assert.equal(
        (
          await request(
            'POST',
            '/concept-orders',
            'measurements',
            { ...input, wardrobeMeasurements: [{ size: 'L', heightCm: 170, weightKg: 60 }] },
            key,
          )
        ).status,
        409,
      );
      const staffView = await request('GET', `/concept-orders/${order._id}`, 'photo');
      assert.equal(staffView.status, 200);
      assert.deepEqual(staffView.body.data.wardrobeMeasurements, input.wardrobeMeasurements);
      assert.equal((await request('GET', `/concept-orders/${order._id}`, 'photo2')).status, 404);
      const { loadRentalHolds, rentalUsageOnDay } = require('../src/services/rentalAvailability');
      const holds = await loadRentalHolds([String(costume._id)]);
      assert.equal(
        rentalUsageOnDay(
          holds.orders,
          holds.schedules,
          String(costume._id),
          'M',
          require('../src/utils/rentalPeriod').vietnamDay(new Date(input.startAt)),
        ).quantity,
        0,
      );
      await Order.updateOne(
        { _id: order._id },
        { $set: { 'reservation.expiresAt': new Date(Date.now() - 1) } },
      );
      await require('../src/services/conceptBooking').expireConceptOrders();
    },
  );
  await t.test('checkout idempotency, last studio race and shared inventory hold', async () => {
    const key = randomUUID();
    const b = body();
    const r = await request('POST', '/concept-orders', 'client', b, key);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.snapshot.decor.backdrop, 'Phông kem');
    first = r.body.data;
    const retry = await request('POST', '/concept-orders', 'client', b, key);
    assert.equal(retry.body.data._id, first._id);
    assert.equal(
      (await request('POST', '/concept-orders', 'client', { ...b, people: 2 }, key)).status,
      409,
    );
    assert.equal(
      (await request('POST', '/concept-orders', 'other', body(future(), 'photo2', false))).status,
      409,
    );
    const {
      loadRentalHolds,
      getRentalAvailability,
    } = require('../src/services/rentalAvailability');
    const holds = await loadRentalHolds([String(costume._id)]);
    assert.equal(
      getRentalAvailability(
        costume,
        { receiveDate: new Date(first.startAt), returnDate: new Date(first.endAt) },
        holds.orders,
        holds.schedules,
      ).M,
      undefined,
    );
    const races = await Promise.all([
      request('POST', '/concept-orders', 'client', body(future(6), 'photo', false)),
      request('POST', '/concept-orders', 'other', body(future(6), 'photo2', false)),
    ]);
    assert.deepEqual(races.map((r) => r.status).sort(), [201, 409]);
  });
  await t.test(
    'signed partial deposits, duplicate receipt, overpayment and exactly one schedule',
    async () => {
      assert.equal((await request('POST', '/payments/sepay/webhook', '', {})).status, 401);
      const partial = await pay(first._id, 'deposit', 100000);
      await require('../src/services/sepay').ingestSePayPayload(partial);
      assert.equal((await Order.findById(first._id)).payments.length, 1);
      assert.equal(await Schedule.countDocuments({ conceptOrder: first._id }), 0);
      await pay(first._id, 'deposit', 400000);
      assert.equal(
        (await Receipt.findOne({ providerTransactionId: String(receiptId) })).status,
        'review',
      );
      await pay(first._id, 'deposit', 200000);
      const order = await Order.findById(first._id);
      assert.equal(order.status, 'confirmed');
      assert.equal(order.reservation.status, 'transferred');
      assert.equal(await Schedule.countDocuments({ conceptOrder: first._id }), 1);
      const { loadRentalHolds, rentalUsageOnDay } = require('../src/services/rentalAvailability');
      const holds = await loadRentalHolds([String(costume._id)]);
      assert.equal(
        rentalUsageOnDay(
          holds.orders,
          holds.schedules,
          String(costume._id),
          'M',
          require('../src/utils/rentalPeriod').vietnamDay(order.startAt),
        ).quantity,
        1,
      );
    },
  );
  await t.test('ownership, legacy schedule/ledger protection and atomic reschedule', async () => {
    assert.equal((await request('GET', `/concept-orders/${first._id}`, 'other')).status, 404);
    assert.equal((await request('GET', `/concept-orders/${first._id}`, 'photo2')).status, 404);
    const order = await Order.findById(first._id);
    assert.equal(
      (await request('PUT', `/schedules/${order.schedule}`, 'admin', { startTime: '15:00' }))
        .status,
      409,
    );
    const tx = await Transaction.findOne({ conceptOrder: order._id });
    assert.equal((await request('DELETE', `/transactions/${tx._id}`, 'admin')).status, 409);
    const blocked = await command(first._id, 'reschedule', { startAt: future(6) });
    assert.equal(blocked.status, 409);
    assert.equal(+(await Order.findById(first._id)).startAt, +order.startAt);
    const moved = await command(first._id, 'reschedule', { startAt: future(8) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.data.rescheduleCount, 1);
    assert.equal((await command(first._id, 'reschedule', { startAt: future(9) })).status, 409);
  });
  await t.test('expiry ignores late money and cancellation records actual refunds', async () => {
    const expired = await make(future(10), 'other', 'photo2', false);
    await Order.updateOne(
      { _id: expired._id },
      { $set: { 'reservation.expiresAt': new Date(Date.now() - 1) } },
    );
    const expiring = await Order.findById(expired._id);
    const pending = expiring.paymentRequests[0];
    await require('../src/services/conceptBooking').expireConceptOrders();
    const lateId = await require('../src/services/sepay').ingestSePayPayload({
      id: ++receiptId,
      gateway: 'MBBank',
      accountNumber: '123456789',
      content: pending.reference,
      code: pending.reference,
      transferType: 'in',
      transferAmount: 300000,
      transactionDate: new Date(Date.now() + 7 * HOUR).toISOString().slice(0, 19).replace('T', ' '),
      referenceCode: 'LATE-' + receiptId,
    });
    assert.equal((await Receipt.findById(lateId)).status, 'review');
    assert.equal(await Schedule.countDocuments({ conceptOrder: expired._id }), 0);
    const reconcile = await command(
      expired._id,
      'reconcile',
      { receiptId: String(lateId), note: 'Tiền về sau hạn' },
      'account',
    );
    assert.equal(reconcile.status, 200, JSON.stringify(reconcile.body));
    assert.equal(reconcile.body.data.refundDue, 300000);
    const r = await command(first._id, 'cancel');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.refundDue, 300000);
    assert.equal(r.body.data.retained, 0);
    assert.equal(
      (await command(first._id, 'refund', { amount: 100000, reference: 'refund-1' }, 'sale'))
        .status,
      403,
    );
    const refunded = await command(
      first._id,
      'refund',
      { amount: 300000, reference: 'refund-1' },
      'account',
    );
    assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
    assert.equal(refunded.body.data.refundDue, 0);
  });
  let albumOrder;
  await t.test('shoot completion and remaining payment gate album and sharing', async () => {
    albumOrder = await make(future(12));
    await pay(albumOrder._id, 'deposit');
    // Isolated fixture moves its own confirmed schedule into the past to exercise the shoot action.
    await Order.updateOne(
      { _id: albumOrder._id },
      { $set: { startAt: new Date(Date.now() - 7200000), endAt: new Date(Date.now() - 3600000) } },
    );
    assert.equal((await command(albumOrder._id, 'shot', {}, 'photo')).status, 200);
    const sync = await albumCommand(
      albumOrder._id,
      'sync',
      { folders: ['https://drive.google.com/drive/folders/folder_color_001'] },
      'photo',
    );
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal((await albumCommand(albumOrder._id, 'publish', {}, 'photo')).status, 409);
    assert.equal((await request('GET', `/concept-orders/${albumOrder._id}/album`)).status, 404);
    await pay(albumOrder._id, 'balance');
    assert.equal((await albumCommand(albumOrder._id, 'publish', {}, 'photo')).status, 200);
  });
  await t.test(
    'server selections, stale writes, extra fee, reopen credit and immutable selection history',
    async () => {
      const photos = await Photo.find({
        album: (await Album.findOne({ order: albumOrder._id }))._id,
        version: 0,
      });
      for (const p of photos)
        assert.equal(
          (
            await albumCommand(albumOrder._id, 'photo', {
              photoId: String(p._id),
              selected: true,
              note: 'Sáng hơn',
            })
          ).status,
          200,
        );
      const a = await Album.findOne({ order: albumOrder._id });
      assert.equal(
        (
          await request('POST', `/concept-orders/${albumOrder._id}/album/photo`, 'client', {
            expectedVersion: a.version - 1,
            photoId: String(photos[0]._id),
            selected: false,
          })
        ).status,
        409,
      );
      includeSecond = false;
      await albumCommand(
        albumOrder._id,
        'sync',
        { folders: ['https://drive.google.com/drive/folders/folder_color_001'] },
        'photo',
      );
      const missing = await Photo.findOne({ album: a._id, available: false, selected: true });
      assert.ok(missing);
      assert.equal(
        (
          await albumCommand(albumOrder._id, 'photo', {
            photoId: String(missing._id),
            selected: false,
          })
        ).status,
        200,
      );
      includeSecond = true;
      await albumCommand(
        albumOrder._id,
        'sync',
        { folders: ['https://drive.google.com/drive/folders/folder_color_001'] },
        'photo',
      );
      assert.equal(
        (
          await albumCommand(albumOrder._id, 'photo', {
            photoId: String(missing._id),
            selected: true,
          })
        ).status,
        200,
      );
      const finalize = await albumCommand(albumOrder._id, 'finalize', { accepted: true });
      assert.equal(finalize.status, 200, JSON.stringify(finalize.body));
      assert.equal(finalize.body.data.extraAmount, 50000);
      assert.equal(finalize.body.data.status, 'awaiting_extra');
      assert.equal((await albumCommand(albumOrder._id, 'start', {}, 'photo')).status, 409);
      await pay(albumOrder._id, 'extra');
      assert.equal((await Album.findOne({ order: albumOrder._id })).status, 'queued');
      assert.equal((await albumCommand(albumOrder._id, 'reopen', {}, 'admin')).status, 200);
      assert.equal(
        (await albumCommand(albumOrder._id, 'finalize', { accepted: true })).status,
        200,
      );
      const o = await Order.findById(albumOrder._id);
      assert.equal(o.paymentRequests.filter((p) => p.kind === 'extra').length, 1);
      assert.equal((await Album.findOne({ order: o._id })).selections.length, 2);
      assert.equal((await albumCommand(albumOrder._id, 'start', {}, 'photo')).status, 200);
    },
  );
  const deliver = async () => {
    const r = await albumCommand(
      albumOrder._id,
      'deliver',
      { folders: ['https://drive.google.com/drive/folders/folder_retouch_001'] },
      'photo',
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.data;
  };
  await t.test(
    'read-only expiring guest links, image permission and downloadable ZIP',
    async () => {
      let a = await deliver();
      const share = await albumCommand(albumOrder._id, 'share', {}, 'admin');
      assert.equal(share.status, 200);
      const token = share.body.data.token,
        pub = share.body.data.share.publicId;
      const guest = await realFetch(`${base}/public/concept-albums/${pub}`, {
        headers: { 'X-Album-Token': token },
      });
      assert.equal(guest.status, 200);
      const body = await guest.json();
      assert.equal(body.data.feedbackRounds, undefined);
      assert.equal(body.data.allowDownload, false);
      assert.equal(
        (await request('POST', `/public/concept-albums/${pub}/photo`, '', {})).status,
        404,
      );
      const photo = a.photos.find((p) => p.version === 1);
      const dl = await request(
        'GET',
        `/concept-orders/${albumOrder._id}/album/photos/${photo.id}?download=true`,
      );
      assert.equal(dl.status, 200);
      assert.ok(Buffer.isBuffer(dl.body));
      const zip = await request('GET', `/concept-orders/${albumOrder._id}/album/zip?version=1`);
      assert.equal(zip.status, 200);
      assert.equal(zip.body.readUInt32LE(0), 0x04034b50);
      assert.equal(
        (await request('GET', `/concept-orders/${albumOrder._id}/album/zip`, 'other')).status,
        404,
      );
      await albumCommand(albumOrder._id, 'revoke', {}, 'admin');
      assert.equal(
        (
          await realFetch(`${base}/public/concept-albums/${pub}`, {
            headers: { 'X-Album-Token': token },
          })
        ).status,
        404,
      );
    },
  );
  await t.test(
    'two aggregate feedback rounds and third paid request cannot start before payment',
    async () => {
      for (let round = 1; round <= 2; round++) {
        const a = (await request('GET', `/concept-orders/${albumOrder._id}/album`)).body.data;
        const p = a.photos.find((p) => p.version === a.deliveryVersion);
        const r = await albumCommand(albumOrder._id, 'feedback', {
          deliveryVersion: a.deliveryVersion,
          items: [{ photoId: p.id, note: 'Sáng hơn' }],
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const feedback = r.body.data.feedbackRounds[round - 1];
        assert.equal(
          (
            await albumCommand(
              albumOrder._id,
              'deliver',
              { folders: ['https://drive.google.com/drive/folders/folder_retouch_001'] },
              'photo',
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await albumCommand(
              albumOrder._id,
              'resolve',
              { roundId: feedback.id, photoId: p.id, resolved: true },
              'photo',
            )
          ).status,
          200,
        );
        await deliver();
      }
      const a = (await request('GET', `/concept-orders/${albumOrder._id}/album`)).body.data;
      const p = a.photos.find((p) => p.version === a.deliveryVersion);
      assert.equal(
        (
          await albumCommand(albumOrder._id, 'feedback', {
            deliveryVersion: a.deliveryVersion,
            items: [{ photoId: p.id, note: 'Thêm' }],
          })
        ).status,
        409,
      );
      const extra = await albumCommand(albumOrder._id, 'request-extra', {
        deliveryVersion: a.deliveryVersion,
        items: [{ photoId: p.id, note: 'Chỉnh thêm' }],
      });
      assert.equal(extra.status, 200);
      const req = extra.body.data.paidRequests[0];
      assert.equal(
        (
          await albumCommand(
            albumOrder._id,
            'quote',
            { requestId: req.id, amount: 100000, terms: 'Sửa ánh sáng' },
            'admin',
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await albumCommand(albumOrder._id, 'accept-quote', {
            requestId: req.id,
            amount: 100000,
            accepted: true,
          })
        ).status,
        200,
      );
      assert.equal(
        (await albumCommand(albumOrder._id, 'start', { requestId: req.id }, 'photo')).status,
        409,
      );
      await pay(albumOrder._id, 'revision');
      assert.equal(
        (await albumCommand(albumOrder._id, 'start', { requestId: req.id }, 'photo')).status,
        200,
      );
      assert.equal(
        (
          await albumCommand(
            albumOrder._id,
            'resolve',
            { roundId: req.id, photoId: p.id, resolved: true },
            'photo',
          )
        ).status,
        200,
      );
      const last = await deliver();
      assert.equal(
        (await albumCommand(albumOrder._id, 'accept', { deliveryVersion: last.deliveryVersion }))
          .status,
        200,
      );
      assert.equal((await Order.findById(albumOrder._id)).status, 'completed');
    },
  );
  if (process.env.CONCEPT_BROWSER_TEST === 'true')
    await t.test('real browser checkout, payment, mobile album and admin catalog', async () => {
      process.env.SEPAY_DEMO_UI = 'true';
      process.env.NODE_ENV = 'development';
      await require('../../ops/concept-browser-check.cjs')({
        base,
        actors,
        token,
        orderId: String(albumOrder._id),
      });
    });
});
