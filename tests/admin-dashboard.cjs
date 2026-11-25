process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'isolated-admin-dashboard-test';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboardUserPeriods, dashboardUsers } = require('../src/services/dashboardUsers');
const User = require('../src/models/User').default;

test('user periods use Vietnam month boundaries and cap comparisons at the shorter month', () => {
  const edge = dashboardUserPeriods(new Date('2026-10-31T17:00:00Z'));
  assert.equal(edge.currentStart.toISOString(), '2026-10-31T17:00:00.000Z');
  assert.deepEqual(edge.months, ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  const mid = dashboardUserPeriods(new Date('2026-11-14T03:30:00Z'));
  assert.equal(mid.previousStart.toISOString(), '2026-09-30T17:00:00.000Z');
  assert.equal(mid.previousEnd.toISOString(), '2026-10-14T03:30:00.000Z');
  const short = dashboardUserPeriods(new Date('2024-03-31T10:00:00Z'));
  assert.equal(short.previousEnd.toISOString(), '2024-02-29T17:00:00.000Z');
});

test('user growth fills empty months, counts each account once and handles zero/negative comparisons', async (t) => {
  let previous = 64;
  let calls = 0;
  t.mock.method(User, 'countDocuments', async () => [1248, 80, previous][calls++ % 3]);
  t.mock.method(User, 'aggregate', async (pipeline) => {
    assert.equal(pipeline[1].$group._id.$dateToString.timezone, 'Asia/Ho_Chi_Minh');
    return [{ _id: '2026-11', count: 80 }];
  });
  const now = new Date('2026-11-14T03:30:00Z');
  const result = await dashboardUsers(now);
  assert.equal(result.total, 1248);
  assert.equal(result.difference, 16);
  assert.equal(result.percent, 25);
  assert.deepEqual(
    result.monthly.map((row) => row.count),
    [0, 0, 0, 0, 0, 80],
  );
  previous = 0;
  assert.equal((await dashboardUsers(now)).percent, null);
  previous = 100;
  const declined = await dashboardUsers(now);
  assert.equal(declined.difference, -20);
  assert.equal(declined.percent, -20);
});

test('dashboard HTTP exposes only aggregate user growth to admins and preserves staff permissions', async (t) => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const Transaction = require('../src/models/Transaction').default;
  const Customer = require('../src/models/Customer').default;
  const Schedule = require('../src/models/Schedule').default;
  let userReads = 0;
  t.mock.method(User, 'findById', (role) => ({
    select: async () => ({
      _id: '000000000000000000000001',
      roles: [Number(role)],
      isActive: true,
    }),
  }));
  t.mock.method(User, 'countDocuments', async () => {
    userReads++;
    return 0;
  });
  t.mock.method(User, 'aggregate', async () => {
    userReads++;
    return [];
  });
  t.mock.method(Transaction, 'aggregate', async () => [
    { totals: [{ _id: 'income', total: 500 }], daily: [] },
  ]);
  t.mock.method(Customer, 'countDocuments', async () => 0);
  t.mock.method(Schedule, 'countDocuments', async () => 0);
  t.mock.method(Schedule, 'find', () => {
    const chain = {
      populate: () => chain,
      sort: () => chain,
      limit: () => chain,
      lean: async () => [],
    };
    return chain;
  });
  const app = express();
  app.use('/dashboard', require('../src/routes/dashboard').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (role) =>
    fetch(`http://127.0.0.1:${server.address().port}/dashboard`, {
      headers:
        role === undefined
          ? {}
          : {
              Authorization: `Bearer ${jwt.sign({ id: String(role) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`,
            },
    });
  assert.equal((await get()).status, 401);
  assert.equal((await get(6)).status, 403);
  assert.equal(userReads, 0);
  for (const role of [2, 4]) assert.equal((await get(role)).status, 401);
  for (const role of [0, 1, 3]) {
    const response = await get(role);
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    if (role < 2) {
      assert.equal(data.users.total, 0);
      assert.equal(data.users.monthly.length, 6);
      assert.equal(data.users.percent, null);
      assert.equal(JSON.stringify(data.users).includes('username'), false);
    } else assert.equal(data.users, undefined);
  }
  assert.equal(userReads, 8, 'only the two admin requests query account aggregates');
});
