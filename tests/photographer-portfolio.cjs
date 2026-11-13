const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
process.env.CONCEPT_BOOKING_ENABLED = 'true';
process.env.JWT_SECRET = 'portfolio-integration-only';
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const User = require('../src/models/User').default;
const Concept = require('../src/models/Concept').default;
const Profile = require('../src/models/PhotographerProfile').default;
const { withResourceTransaction } = require('../src/services/workflowTransactions');
const { saveAdminPortfolio } = require('../src/services/photographerPortfolio');
const { availablePhotographers } = require('../src/services/conceptBooking');

test('personal portfolio drafts, public snapshots, uploads, ownership and version conflicts', async (t) => {
  const uri = new URL(process.env.MONGO_TEST_URI || process.env.MONGO_URI);
  assert.ok(['127.0.0.1', 'localhost'].includes(uri.hostname));
  const database = `studio_portfolio_test_${process.pid}`;
  uri.pathname = `/${database}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-portfolio-'));
  process.env.PORTFOLIO_UPLOAD_DIR = directory;
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 5000 });
  assert.equal(mongoose.connection.name, database);
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    assert.equal(mongoose.connection.name, database);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('studio-portfolio-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await Promise.all([User.init(), Concept.init(), Profile.init()]);
  const [a, b, client] = await User.create(
    [
      { username: 'portfolio.a', name: 'Thợ A', roles: [3] },
      { username: 'portfolio.b', name: 'Thợ B', roles: [3] },
      { username: 'portfolio.client', name: 'Khách', roles: [6] },
    ].map((user) => ({ ...user, isActive: true, password: 'TestOnly123!' })),
  );
  const concept = await Concept.create({ name: 'Chân dung', active: true });
  const other = await Concept.create({ name: 'Không phân công', active: true });
  const original = {
    portraitUrl: '/images/concepts/portrait.webp',
    bio: 'Giới thiệu cũ',
    title: 'Chuyên môn cũ',
    portfolio: [
      { concept: concept.id, url: '/images/concepts/work.webp', caption: 'Cũ', permitted: true },
    ],
  };
  // A real legacy document without draft/revision fields.
  await Profile.collection.insertOne({
    photographer: a._id,
    concepts: [concept._id],
    published: true,
    ...original,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/photographers', require('../src/routes/photographerPortfolio').default);
  app.use('/api/photographers', require('../src/routes/photographerAvailability').default);
  app.use('/api/concepts', require('../src/routes/concepts').default);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = (user) =>
    user ? { Authorization: `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}` } : {};
  const get = async (url, user) => {
    const res = await fetch(base + url, { headers: headers(user) });
    return { status: res.status, body: await res.json() };
  };
  const write = async (state, content, publish = false, user = a, images = []) => {
    const data = new FormData();
    data.append('content', JSON.stringify({ revision: state.revision, content }));
    images.forEach((image) =>
      data.append('images', new Blob([image], { type: 'image/jpeg' }), 'photo.jpg'),
    );
    const res = await fetch(
      base + '/api/photographers/me/portfolio' + (publish ? '/publish' : ''),
      { method: publish ? 'POST' : 'PUT', headers: headers(user), body: data },
    );
    return { status: res.status, body: await res.json() };
  };
  await t.test(
    'portfolio feature gate does not intercept existing photographer availability routes',
    async () => {
      process.env.CONCEPT_BOOKING_ENABLED = 'false';
      try {
        assert.equal((await get('/api/photographers/me/portfolio', a)).status, 404);
        assert.equal((await get('/api/photographers/availability', client)).status, 403);
      } finally {
        process.env.CONCEPT_BOOKING_ENABLED = 'true';
      }
    },
  );
  let state;
  await t.test(
    'existing data and blank profiles are read without creating duplicates; role checks',
    async () => {
      state = (await get('/api/photographers/me/portfolio', a)).body.data;
      assert.equal(state.revision, 0);
      assert.equal(state.content.bio, original.bio);
      assert.equal((await get('/api/photographers/me/portfolio', client)).status, 403);
      assert.equal((await get('/api/photographers/me/portfolio')).status, 401);
      const blank = (await get('/api/photographers/me/portfolio', b)).body.data;
      assert.equal(blank.content.bio, '');
      assert.equal(blank.concepts.length, 0);
      assert.equal(await Profile.countDocuments({ photographer: b._id }), 0);
    },
  );
  await t.test(
    'draft is private and reloadable; public route and legacy booking profile keep old snapshot',
    async () => {
      const draft = { ...state.content, bio: 'Bản nháp riêng', title: 'Chuyên môn mới' };
      const saved = await write(state, draft);
      assert.equal(saved.status, 200);
      state = saved.body.data;
      assert.equal(state.content.bio, draft.bio);
      assert.equal(state.hasDraft, true);
      assert.equal((await get(`/api/photographers/${a.id}/portfolio`)).body.data.bio, original.bio);
      const legacy = (await get(`/api/concepts/photographers/${a.id}`)).body.data;
      assert.equal(legacy.bio, original.bio);
      assert.equal(legacy.draft, undefined);
      assert.equal(
        (await get('/api/photographers/me/portfolio', a)).body.data.content.bio,
        draft.bio,
      );
      assert.equal((await write({ revision: 0 }, draft)).status, 409);
      const rejected = await write(state, {
        ...draft,
        portfolio: [{ ...draft.portfolio[0], concept: other.id }],
      });
      assert.equal(rejected.status, 400);
    },
  );
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aabbcc' } })
    .jpeg()
    .toBuffer();
  let uploaded;
  await t.test(
    'uploads are validated and cannot be read by guests or other photographers before publication',
    async () => {
      const content = {
        ...state.content,
        portraitUrl: 'upload:0',
        coverUrl: 'upload:0',
        portfolio: [{ concept: concept.id, url: 'upload:0', caption: 'Ảnh mới', permitted: true }],
      };
      const saved = await write(state, content, false, a, [image]);
      assert.equal(saved.status, 200);
      state = saved.body.data;
      uploaded = state.content.portraitUrl;
      assert.equal((await fetch(base + uploaded)).status, 404);
      assert.equal((await fetch(base + uploaded, { headers: headers(b) })).status, 404);
      assert.equal((await fetch(base + uploaded, { headers: headers(a) })).status, 200);
      assert.equal(
        (await write(state, { ...state.content, portraitUrl: 'https://example.com/unowned.jpg' }))
          .status,
        400,
      );
      assert.equal(
        (await write(state, content, false, a, [Buffer.from('not-an-image')])).status,
        400,
      );
      assert.equal(
        (await write(state, content, false, a, [Buffer.alloc(5 * 1024 * 1024 + 1)])).status,
        413,
      );
      assert.equal(
        (
          await write(state, {
            ...state.content,
            portfolio: Array.from({ length: 101 }, () => state.content.portfolio[0]),
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    'publishing updates all public views; failed publish preserves existing public content and files',
    async () => {
      const saved = await write(state, state.content, true);
      assert.equal(saved.status, 200);
      state = saved.body.data;
      assert.equal(state.hasDraft, false);
      const publicState = (await get(`/api/photographers/${a.id}/portfolio`)).body.data;
      assert.equal(publicState.title, state.content.title);
      assert.equal(publicState.portfolio[0].caption, 'Ảnh mới');
      assert.equal(
        (await get(`/api/concepts/photographers/${a.id}`)).body.data.portraitUrl,
        uploaded,
      );
      assert.equal((await fetch(base + uploaded)).status, 200);
      const rows = await availablePhotographers(
        { concept: concept._id },
        new Date('2099-01-01T01:00:00Z'),
        new Date('2099-01-01T02:00:00Z'),
      );
      assert.equal(rows.find((r) => r._id === a.id).title, state.content.title);
      const failed = await write(
        state,
        { ...state.content, bio: '', story: '', portraitUrl: 'upload:0' },
        true,
        a,
        [image],
      );
      assert.equal(failed.status, 400);
      assert.equal(
        (await get(`/api/photographers/${a.id}/portfolio`)).body.data.portraitUrl,
        uploaded,
      );
      const draft = await write(state, { ...state.content, portraitUrl: original.portraitUrl });
      // Old URLs removed from both snapshots cannot be reintroduced by guessing them.
      assert.equal(draft.status, 400);
      const replacement = await write(
        state,
        { ...state.content, portraitUrl: 'upload:0', coverUrl: '', portfolio: [] },
        false,
        a,
        [image],
      );
      assert.equal(replacement.status, 200);
      state = replacement.body.data;
      assert.equal(
        (await fetch(base + uploaded)).status,
        200,
        'public image remains while draft removes it',
      );
      assert.equal(
        (await fs.readdir(path.join(directory, a.id))).length,
        2,
        'failed upload has been cleaned',
      );
    },
  );
  await t.test(
    'admin and photographer use the same draft and revision; malicious targeting does not change owner',
    async () => {
      const oldRevision = state.revision;
      const adminBody = {
        ...state.content,
        photographer: a.id,
        concepts: [concept.id],
        published: false,
        revision: oldRevision,
        bio: 'Admin chỉnh bản nháp',
      };
      for (const invalid of [{ portfolio: {} }, { portraitUrl: 42 }, { audience: null }]) {
        await assert.rejects(
          withResourceTransaction((session) =>
            saveAdminPortfolio({ ...adminBody, ...invalid }, session),
          ),
          (e) => e.status === 400,
        );
      }
      await withResourceTransaction((session) => saveAdminPortfolio(adminBody, session));
      assert.equal((await write(state, state.content)).status, 409);
      const latest = (await get('/api/photographers/me/portfolio', a)).body.data;
      assert.equal(latest.content.bio, adminBody.bio);
      await assert.rejects(
        withResourceTransaction((session) => saveAdminPortfolio(adminBody, session)),
        (e) => e.status === 409,
      );
      const saved = await write(latest, {
        ...latest.content,
        photographer: b.id,
        concepts: [other.id],
        bio: 'Chỉ của A',
      });
      assert.equal(saved.status, 200);
      assert.equal(await Profile.countDocuments({ photographer: b._id }), 0);
      assert.equal((await get(`/api/photographers/${a.id}/portfolio`)).status, 404);
      assert.equal((await fetch(base + uploaded)).status, 404);
      const blank = (await get('/api/photographers/me/portfolio', b)).body.data;
      assert.equal((await write(blank, blank.content, true, b)).status, 400);
      assert.equal((await write(blank, blank.content, false, b)).status, 200);
    },
  );
});
