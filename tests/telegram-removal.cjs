const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');

process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');

// Load the actual app without opening a database or starting background providers.
require('../src/config/db').default = () => new Promise(() => {});
const app = require('../src/app').default;

test('removed Telegram routes return 404 while the application remains healthy', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const requestStatus = (method, route) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { hostname: '127.0.0.1', port: server.address().port, path: route, method },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
      request.end();
    });

  assert.equal(await requestStatus('GET', '/api/health'), 200);
  for (const [method, route] of [
    ['GET', '/api/telegram/status'],
    ['POST', '/api/telegram/generate-link-token'],
    ['DELETE', '/api/telegram/unlink'],
    ['POST', '/api/telegram/webhook'],
  ]) {
    assert.equal(await requestStatus(method, route), 404, method + ' ' + route);
  }
});

test(
  'legacy fields stay private and cleanup preserves edits made after backup',
  { skip: !process.env.MONGO_TEST_URI },
  async (t) => {
    const mongoose = require('mongoose');
    const jwt = require('jsonwebtoken');
    const User = require('../src/models/User').default;
    const { snapshotFilter } = require('../src/utils/removeTelegram');
    const database = `studio_telegram_removal_test_${process.pid}`;
    const uri = new URL(process.env.MONGO_TEST_URI);
    assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname));
    uri.pathname = `/${database}`;
    await mongoose.connect(uri.toString());
    let server;
    t.after(async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      assert.equal(mongoose.connection.name, database);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    const id = new mongoose.Types.ObjectId();
    const legacy = {
      _id: id,
      username: 'legacy.admin',
      name: 'Legacy Admin',
      roles: [1],
      isActive: true,
      email: 'legacy@example.com',
      notificationReadAt: new Date(),
      password: 'private-hash',
      emailVerification: { tokenHash: 'private-email-token' },
      telegramId: null,
      telegramLinkToken: 'private-link-token',
      telegramLinkTokenExpiry: new Date(),
    };
    await User.collection.insertOne(legacy);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const token = jwt.sign({ id: id.toString() }, process.env.JWT_SECRET);
    for (const [method, route, body] of [
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/refresh'],
      ['PATCH', '/api/auth/profile', { name: 'Updated Admin' }],
      ['GET', '/api/users'],
      ['GET', `/api/users/${id}`],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, route);
      const payload = await response.text();
      assert.doesNotMatch(
        payload,
        /telegram|private-hash|private-email-token|emailVerification/i,
        route,
      );
      assert.match(payload, /legacy@example.com/, route);
    }
    const snapshot = await User.collection.findOne({ _id: id });
    const filter = snapshotFilter(snapshot);
    // Missing and null must compare differently, and changes to an existing token must survive.
    await User.collection.updateOne({ _id: id }, { $set: { telegramUsername: null } });
    const unset = {
      $unset: {
        telegramId: '',
        telegramUsername: '',
        telegramLinkToken: '',
        telegramLinkTokenExpiry: '',
      },
    };
    assert.equal((await User.collection.updateOne(filter, unset)).modifiedCount, 0);
    await User.collection.updateOne(
      { _id: id },
      { $unset: { telegramUsername: '' }, $set: { telegramLinkToken: 'new-value' } },
    );
    assert.equal((await User.collection.updateOne(filter, unset)).modifiedCount, 0);
    const current = await User.collection.findOne({ _id: id });
    assert.equal(current.telegramLinkToken, 'new-value');
    assert.equal(
      (await User.collection.updateOne(snapshotFilter(current), unset)).modifiedCount,
      1,
    );
    const cleaned = await User.collection.findOne({ _id: id });
    assert.ok(Object.keys(cleaned).every((key) => !key.startsWith('telegram')));
    assert.equal(cleaned.password, legacy.password);
    assert.equal(cleaned.email, legacy.email);
    assert.equal(cleaned.name, 'Updated Admin');
  },
);
