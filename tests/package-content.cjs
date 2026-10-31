// Isolated HTTP/filesystem contracts. Never connects to an application database.
const path = require('node:path');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'package-content-tests-only';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const Package = require('../src/models/Package').default;
const User = require('../src/models/User').default;
const { readPackageContent } = require('../src/utils/packageContentInput');

test('content validation preserves ordering and rejects malformed references and fields', () => {
  const parsed = readPackageContent(
    {
      version: 0,
      details: {
        deliverables: '  20 ảnh chỉnh sửa/người\nNhận qua Google Drive  ',
        shootScope: '4 giờ, 2 concept, 1 địa điểm',
        pricingConditions: 'Từ 30 người tại Hà Nội',
        benefits: ['  Có album  '],
        itinerary: [{ time: '08:00', title: 'Tập trung' }],
        extraCosts: [{ name: 'Di chuyển', priceLabel: 'Tùy địa điểm' }],
      },
    },
    0,
  );
  assert.deepEqual(parsed.details.benefits, ['Có album']);
  assert.equal(parsed.details.itinerary[0].description, '');
  assert.equal(parsed.details.deliverables, '20 ảnh chỉnh sửa/người\nNhận qua Google Drive');
  for (const key of ['deliverables', 'shootScope', 'pricingConditions']) {
    assert.equal(readPackageContent({ version: 0, details: {} }, 0).details[key], '');
    assert.equal(new Package({ details: parsed.details }).details[key], parsed.details[key]);
    for (const value of [null, 30, [], {}, 'x'.repeat(4001)]) {
      assert.throws(() => readPackageContent({ version: 0, details: { [key]: value } }, 0));
    }
  }
  for (const raw of [
    null,
    {},
    { version: -1, details: {} },
    { version: 0, details: { benefits: [null] } },
    { version: 0, details: { process: [{ title: '' }] } },
    { version: 0, details: { gallery: [{ id: '../../secret', alt: 'Ảnh' }] } },
    { version: 0, details: { gallery: [{ uploadIndex: 0, alt: 'Ảnh' }] } },
    { version: 0, details: { depositPolicy: 'x'.repeat(4001) } },
    { version: 0, details: { benefits: Array(31).fill('x') } },
  ])
    assert.throws(() => readPackageContent(raw, 0));
  assert.throws(() => readPackageContent({ version: 0, details: {} }, 1));
  assert.throws(() =>
    readPackageContent(
      {
        version: 0,
        details: {
          gallery: [
            { uploadIndex: 0, alt: 'A' },
            { uploadIndex: 0, alt: 'B' },
          ],
        },
      },
      1,
    ),
  );
});

test('public details, editor authorization and image updates remain consistent on failures', async (t) => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), 'studio-package-content-'));
  const originalDir = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = mediaRoot;
  t.after(async () => {
    process.env.UPLOAD_DIR = originalDir || '';
    await rm(mediaRoot, { recursive: true, force: true });
  });
  const id = '000000000000000000000011';
  let pkg = { _id: id, name: 'Gói thử', pricePerMember: 500000, costumes: [], detailsVersion: 0 };
  let failWrite = false;
  let failAfterWrite = false;
  let loseRace = false;
  const query = (read) => ({
    select() {
      return this;
    },
    populate() {
      return this;
    },
    async lean() {
      return read();
    },
  });
  t.mock.method(Package, 'findById', (value) =>
    query(() => (value === id ? structuredClone(pkg) : null)),
  );
  t.mock.method(Package, 'findOneAndUpdate', (_filter, update) =>
    query(() => {
      if (failWrite) throw new Error('Database unavailable');
      if (loseRace) return null;
      pkg = { ...pkg, details: update.$set.details, detailsVersion: pkg.detailsVersion + 1 };
      if (failAfterWrite) throw new Error('Connection lost after commit');
      return structuredClone(pkg);
    }),
  );
  t.mock.method(User, 'findById', (value) => ({
    select: async () => ({ _id: value, roles: [Number(value.slice(-1))], isActive: true }),
  }));
  const token = (role) =>
    jwt.sign({ id: `00000000000000000000000${role}` }, process.env.JWT_SECRET);
  const app = express();
  app.use('/api/media/packages', express.static(mediaRoot));
  app.use('/api/public', require('../src/routes/public').default);
  app.use('/api/packages', require('../src/routes/packages').default);
  app.use((_error, _req, res, _next) => res.status(500).json({ message: 'Failed' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (details = {}, files = [], version = pkg.detailsVersion, role = 0) => {
    const body = new FormData();
    body.set('content', JSON.stringify({ version, details }));
    for (const file of files)
      body.append('images', new Blob([file], { type: 'image/png' }), 'demo.png');
    return fetch(`${base}/api/packages/${id}/content`, {
      method: 'PUT',
      body,
      headers: role === null ? {} : { Authorization: `Bearer ${token(role)}` },
    });
  };
  await t.test(
    'public viewing needs no login and handles invalid or missing packages',
    async () => {
      assert.equal((await fetch(`${base}/api/public/packages/${id}`)).status, 200);
      assert.equal((await fetch(`${base}/api/public/packages/not-an-id`)).status, 400);
      assert.equal(
        (await fetch(`${base}/api/public/packages/000000000000000000000099`)).status,
        404,
      );
    },
  );
  await t.test(
    'invalid editor IDs return 400 without querying or crashing the server',
    async () => {
      const response = await fetch(`${base}/api/packages/not-an-id`, {
        headers: { Authorization: `Bearer ${token(0)}` },
      });
      assert.equal(response.status, 400);
    },
  );
  await t.test('only roles 0 and 1 can save content', async () => {
    assert.equal((await put({}, [], 0, null)).status, 401);
    for (const role of [2, 3, 4, 5, 6]) assert.equal((await put({}, [], 0, role)).status, 403);
    assert.equal((await put({ audience: 'Lớp cuối cấp' }, [], 0, 1)).status, 200);
    assert.equal(pkg.details.audience, 'Lớp cuối cấp');
  });
  await t.test(
    'saves and publicly returns the three optional package information fields',
    async () => {
      const details = {
        deliverables: '20 ảnh chỉnh sửa/người\nAlbum lớp qua Google Drive',
        shootScope: '4 giờ, 2 concept tại sân trường',
        pricingConditions: 'Áp dụng từ 30 thành viên',
      };
      const saved = await put(details);
      assert.equal(saved.status, 200);
      const savedPackage = (await saved.json()).data;
      const publicPackage = (await (await fetch(`${base}/api/public/packages/${id}`)).json()).data;
      for (const [key, value] of Object.entries(details)) {
        assert.equal(savedPackage.details[key], value);
        assert.equal(publicPackage.details[key], value);
      }
      assert.equal(publicPackage.pricePerMember, 500000);
    },
  );
  const png = await sharp({
    create: { width: 200, height: 100, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  await t.test(
    'images are decoded, converted and persisted; metadata never leaks original file bytes',
    async () => {
      const response = await put(
        { gallery: [{ uploadIndex: 0, alt: 'Ảnh lớp', caption: 'Kỷ niệm' }] },
        [png],
      );
      assert.equal(response.status, 200);
      const image = (await response.json()).data.details.gallery[0];
      assert.match(image.id, /^[a-f0-9-]{36}\.webp$/);
      assert.equal(image.width, 200);
      assert.equal(image.height, 100);
      const bytes = await readFile(path.join(mediaRoot, image.id));
      assert.equal((await sharp(bytes).metadata()).format, 'webp');
      assert.equal((await fetch(`${base}/api/media/packages/${image.id}`)).status, 200);
      assert.equal((await readdir(mediaRoot)).length, 1);
    },
  );
  await t.test(
    'rejects forged, duplicate, foreign, oversized and excessive image submissions',
    async () => {
      const original = structuredClone(pkg);
      assert.equal(
        (await put({ gallery: [{ uploadIndex: 0, alt: 'Giả ảnh' }] }, [Buffer.from('<svg></svg>')]))
          .status,
        400,
      );
      assert.equal(
        (
          await put({
            gallery: [{ id: '00000000-0000-4000-8000-000000000000.webp', alt: 'Ảnh khác' }],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await put({ gallery: [{ uploadIndex: 0, alt: 'To' }] }, [
            Buffer.alloc(5 * 1024 * 1024 + 1),
          ])
        ).status,
        413,
      );
      assert.equal((await put({}, Array(11).fill(png))).status, 400);
      assert.deepEqual(pkg, original);
      assert.equal((await readdir(mediaRoot)).length, 1);
    },
  );
  await t.test(
    'a bad second image or failed database write cleans new files and preserves the old gallery',
    async () => {
      const previous = structuredClone(pkg);
      const mixed = await put(
        {
          gallery: [
            { uploadIndex: 0, alt: 'Mới' },
            { uploadIndex: 1, alt: 'Lỗi' },
          ],
        },
        [png, Buffer.from('invalid')],
      );
      assert.equal(mixed.status, 400);
      failWrite = true;
      const failed = await put({ gallery: [{ uploadIndex: 0, alt: 'Mới' }] }, [png]);
      failWrite = false;
      assert.equal(failed.status, 500);
      assert.deepEqual(pkg, previous);
      assert.equal((await readdir(mediaRoot)).length, 1);
    },
  );
  await t.test(
    'stale saves and simultaneous saves do not overwrite content or remove existing images',
    async () => {
      assert.equal((await put({}, [], 0)).status, 409);
      loseRace = true;
      assert.equal((await put({ gallery: [{ uploadIndex: 0, alt: 'Race' }] }, [png])).status, 409);
      loseRace = false;
      assert.equal((await readdir(mediaRoot)).length, 1);
    },
  );
  await t.test('reordering and clearing images takes effect after successful save', async () => {
    const image = pkg.details.gallery[0];
    assert.equal((await put({ gallery: [{ id: image.id, alt: 'Mô tả mới' }] })).status, 200);
    assert.equal(pkg.details.gallery[0].alt, 'Mô tả mới');
    assert.equal((await readdir(mediaRoot)).length, 1);
    assert.equal((await put({})).status, 200);
    assert.deepEqual(pkg.details.gallery, []);
    assert.equal((await readdir(mediaRoot)).length, 0);
  });
  await t.test(
    'a lost write acknowledgement never deletes images already referenced by MongoDB',
    async () => {
      failAfterWrite = true;
      const response = await put({ gallery: [{ uploadIndex: 0, alt: 'Đã commit' }] }, [png]);
      failAfterWrite = false;
      assert.equal(response.status, 500);
      const image = pkg.details.gallery[0];
      assert.ok(image);
      assert.ok((await readFile(path.join(mediaRoot, image.id))).length > 0);
      assert.equal((await put({})).status, 200);
      assert.equal((await readdir(mediaRoot)).length, 0);
    },
  );
});
