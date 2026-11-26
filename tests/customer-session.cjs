// Real JWT middleware and HTTP routers with model doubles; no MongoDB connection.
process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'isolated-customer-session-secret';
process.env.CONCEPT_BOOKING_ENABLED = 'true';
process.env.CLIENT_PORTAL_ENABLED = 'true';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Class = require('../src/models/Class').default;

test('customer data and shared links require an active session; only portfolio counts remain anonymous', async (t) => {
  let reads = 0;
  User.findById = (id) => ({
    select: async () => ({ _id: id, isActive: id !== 'inactive', roles: [6] }),
  });
  Class.countDocuments = async () => {
    reads++;
    return 7;
  };
  Class.distinct = async () => {
    reads++;
    return ['Trường A', 'Trường A', ' Trường B ', ''];
  };
  const app = express();
  app.use(express.json());
  app.use('/public/concept-albums', require('../src/routes/conceptOrders').publicConceptAlbums);
  app.use('/public', require('../src/routes/public').default);
  app.use('/concepts', require('../src/routes/concepts').default);
  app.use('/rentals', require('../src/routes/rentals').default);
  app.use('/bookings', require('../src/routes/bookings').default);
  app.use((error, req, res, next) => res.status(500).json({ message: 'Unexpected test error' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sign = (id = 'client', expiresIn = '1h') =>
    `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn })}`;
  const request = (path, authorization, method = 'GET') =>
    fetch(base + path, {
      method,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        'X-Album-Token': 'shared-link-token',
        'Content-Type': 'application/json',
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
  const stats = await request('/public/portfolio-stats');
  assert.equal(stats.status, 200);
  assert.deepEqual((await stats.json()).data, { classes: 7, schools: 2 });
  assert.equal(reads, 2);
  for (const authorization of [
    undefined,
    'Bearer malformed',
    sign('client', -1),
    sign('inactive'),
  ]) {
    for (const [path, method = 'GET'] of [
      ['/public/packages'],
      ['/public/packages/id'],
      ['/public/rental-policy'],
      ['/public/costumes'],
      ['/public/costume-types'],
      ['/public/customers/id?access=share'],
      ['/public/students?access=share'],
      ['/public/schedules/customer/id?access=share'],
      ['/public/member-intake/token'],
      ['/public/member-intake/token', 'POST'],
      ['/public/students', 'POST'],
      ['/public/feedback', 'POST'],
      ['/public/albums/id'],
      ['/public/albums/id/photo', 'POST'],
      ['/public/albums/id/photos/photo'],
      ['/public/concept-albums/id'],
      ['/public/concept-albums/id/photos/photo'],
      ['/concepts'],
      ['/concepts/availability'],
      ['/concepts/costumes'],
      ['/concepts/photographers/id'],
      ['/rentals'],
      ['/rentals', 'POST'],
      ['/bookings'],
      ['/bookings', 'POST'],
    ]) {
      const response = await request(path, authorization, method);
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  }
  assert.equal(reads, 2, 'unauthenticated requests do not query customer records');
  const valid = await request('/public/feedback', sign(), 'POST');
  assert.equal(valid.status, 400, 'a live session reaches existing input validation');
  assert.match((await valid.json()).message, /1 đến 5 sao/);
  const unauthorizedLink = await request('/public/customers/invalid?access=wrong', sign());
  assert.equal(unauthorizedLink.status, 404, 'a session does not bypass the class access token');
});
