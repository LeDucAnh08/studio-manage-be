// No DB connection: exercise the real auth, route, controller and query boundaries over HTTP.
process.env.TS_NODE_PROJECT = require('node:path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'personal-calendar-test-secret';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Schedule = require('../src/models/Schedule').default;

test('personal calendar enforces caller ownership, complete Vietnam-day range and read-only role access', async (t) => {
  const photo = '000000000000000000000003';
  const other = '000000000000000000000004';
  const client = '000000000000000000000006';
  const admin = '000000000000000000000001';
  const mixed = '000000000000000000000007';
  const users = Object.fromEntries(
    [
      [photo, [3]],
      [other, [3]],
      [client, [6]],
      [admin, [0]],
      [mixed, [0, 3]],
    ].map(([id, roles]) => [id, { _id: id, roles, isActive: true }]),
  );
  t.mock.method(User, 'findById', (id) => ({ select: async () => users[id] }));
  // More than a legacy page, with lead/support/outsider and both boundary instants.
  const rows = Array.from({ length: 25 }, (_, index) => ({
    _id: `shoot-${index}`,
    shootDate: new Date('2026-11-18T01:00:00Z'),
    leadPhotographer: index % 2 ? other : photo,
    supportPhotographers: index % 2 ? [photo] : [],
    customer: { className: '12A1' },
    package: null,
    status: 'confirmed',
    location: 'Studio',
    startTime: '08:00',
    endTime: '09:00',
    notes: 'Chuẩn bị',
    payment: 'private-finance',
  }));
  rows.push(
    ...[
      { ...rows[0], _id: 'outside', leadPhotographer: other, supportPhotographers: [] },
      { ...rows[0], _id: 'before', shootDate: new Date('2026-10-31T16:59:59.999Z') },
      { ...rows[0], _id: 'first', shootDate: new Date('2026-10-31T17:00:00Z') },
      {
        ...rows[0],
        _id: 'last',
        shootDate: new Date('2026-11-30T16:59:59.999Z'),
        conceptOrder: 'concept-order',
        conceptTitle: 'Chân dung',
      },
      { ...rows[0], _id: 'after', shootDate: new Date('2026-11-30T17:00:00Z') },
    ],
  );
  let filter;
  t.mock.method(Schedule, 'find', (value) => {
    filter = value;
    const query = {
      select: () => query,
      populate: () => query,
      sort: () => query,
      lean: async () =>
        rows.filter(
          (row) =>
            value.$or.some(
              (scope) =>
                scope.leadPhotographer === row.leadPhotographer ||
                (scope.supportPhotographers &&
                  row.supportPhotographers.includes(scope.supportPhotographers)),
            ) &&
            row.shootDate >= value.shootDate.$gte &&
            row.shootDate < value.shootDate.$lt,
        ),
    };
    return query;
  });
  const app = express();
  app.use('/schedules', require('../src/routes/schedules').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = (id, query = '?from=2026-11-01&to=2026-11-30', method = 'GET') =>
    fetch(`http://127.0.0.1:${server.address().port}/schedules/mine/calendar${query}`, {
      method,
      headers: id ? { Authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET)}` } : {},
    });
  assert.equal((await call()).status, 401);
  assert.equal((await call(client)).status, 403);
  assert.equal((await call(admin)).status, 403);
  const response = await call(
    photo,
    '?from=2026-11-01&to=2026-11-30&photographer=' + other + '&limit=1',
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    body.data.length,
    27,
    'All assignments, including beyond page 20 and Vietnam midnight boundaries',
  );
  assert.deepEqual(filter.$or, [{ leadPhotographer: photo }, { supportPhotographers: photo }]);
  assert.equal(filter.shootDate.$gte.toISOString(), '2026-10-31T17:00:00.000Z');
  assert.equal(filter.shootDate.$lt.toISOString(), '2026-11-30T17:00:00.000Z');
  assert.equal(body.data[1].role, 'support');
  assert.equal(body.data.find((row) => row._id === 'last').title, 'Chân dung');
  assert.equal(body.data.find((row) => row._id === 'last').service, 'concept');
  assert.ok(body.data.every((row) => !('payment' in row) && !('customer' in row)));
  assert.equal((await call(mixed)).status, 200);
  assert.deepEqual(
    filter.$or,
    [{ leadPhotographer: mixed }, { supportPhotographers: mixed }],
    'Multi-role users also cannot broaden this personal endpoint',
  );
  assert.equal(
    (await call(photo, '?from=2026-10-26&to=2026-12-06')).status,
    200,
    '42-day grid allowed',
  );
  for (const query of [
    '?from=2026-02-30&to=2026-03-01',
    '?from=2026-11-30&to=2026-11-01',
    '?from=2026-10-25&to=2026-12-06',
    '?from[$ne]=x&to=2026-11-30',
    '?from=2026-11-01&from=2026-11-02&to=2026-11-30',
    '',
  ])
    assert.equal((await call(photo, query)).status, 400);
});
