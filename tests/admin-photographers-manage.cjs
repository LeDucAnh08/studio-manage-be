process.env.TS_NODE_PROJECT = require('node:path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'admin-photographers-manage-test-secret';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Schedule = require('../src/models/Schedule').default;

test('admin photographer management list and schedule calendar enforce roles and return photographer schedules', async (t) => {
  const adminId = '000000000000000000000001';
  const photo1Id = '000000000000000000000003';
  const photo2Id = '000000000000000000000004';
  const clientId = '000000000000000000000006';

  const users = {
    [adminId]: { _id: adminId, username: 'admin', name: 'Quản trị', roles: [1], isActive: true },
    [photo1Id]: {
      _id: photo1Id,
      username: 'nhiepanh.a',
      name: 'Nguyễn An',
      roles: [3],
      isActive: true,
    },
    [photo2Id]: {
      _id: photo2Id,
      username: 'nhiepanh.b',
      name: 'Trần Bình',
      roles: [3],
      isActive: false,
    },
    [clientId]: { _id: clientId, username: 'khach', name: 'Khách', roles: [6], isActive: true },
  };

  t.mock.method(User, 'findById', (id) => {
    const user = users[String(id)] ?? null;
    return {
      select: () => Object.assign(Promise.resolve(user), { lean: async () => user }),
    };
  });

  t.mock.method(User, 'find', () => ({
    select: () => ({
      sort: () => ({
        lean: async () => [users[photo1Id], users[photo2Id]],
      }),
    }),
  }));

  const futureDate = new Date(Date.now() + 3 * 86400000);
  const scheduleRows = [
    {
      _id: 'sch-1',
      leadPhotographer: photo1Id,
      supportPhotographers: [],
      shootDate: futureDate,
      status: 'confirmed',
      startTime: '08:00',
      endTime: '11:00',
      location: 'Sân trường',
      customer: { className: '12A1' },
      package: null,
      workflowBooking: 'wf-1',
    },
    {
      _id: 'sch-2',
      leadPhotographer: photo2Id,
      supportPhotographers: [photo1Id],
      shootDate: new Date(Date.now() - 5 * 86400000),
      status: 'completed',
      startTime: '14:00',
      endTime: '15:30',
      location: 'Yume Studio',
      conceptOrder: 'co-1',
      conceptTitle: 'Chân dung Tự nhiên',
    },
    {
      _id: 'sch-cancelled',
      leadPhotographer: photo1Id,
      supportPhotographers: [],
      shootDate: futureDate,
      status: 'cancelled',
    },
  ];

  t.mock.method(Schedule, 'find', (filter) => {
    const query = {
      select: () => query,
      populate: () => query,
      sort: () => query,
      skip: () => query,
      limit: () => query,
      lean: async () => {
        if (filter?.status?.$ne === 'cancelled') {
          return scheduleRows.filter((r) => r.status !== 'cancelled');
        }
        return scheduleRows.filter((row) => {
          const matchesPhoto =
            !filter?.$or ||
            filter.$or.some(
              (scope) =>
                String(scope.leadPhotographer) === String(row.leadPhotographer) ||
                (scope.supportPhotographers &&
                  row.supportPhotographers.map(String).includes(String(scope.supportPhotographers))),
            );
          const matchesDate =
            !filter?.shootDate ||
            (row.shootDate >= filter.shootDate.$gte && row.shootDate < filter.shootDate.$lt);
          return matchesPhoto && matchesDate;
        });
      },
    };
    return query;
  });

  const app = express();
  app.use('/users', require('../src/routes/users').default);
  app.use('/schedules', require('../src/routes/schedules').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (path, userId) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: userId ? { Authorization: `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET)}` } : {},
    });

  // Authorization checks
  assert.equal((await call('/users/photographers/manage')).status, 401);
  assert.equal((await call('/users/photographers/manage', photo1Id)).status, 403);
  assert.equal((await call('/users/photographers/manage', clientId)).status, 403);

  const listRes = await call('/users/photographers/manage', adminId);
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.data.length, 2);
  assert.deepEqual(listBody.data[0].scheduleStats, { total: 2, upcoming: 1, completed: 1 });
  assert.deepEqual(listBody.data[1].scheduleStats, { total: 1, upcoming: 0, completed: 1 });

  // Photographer calendar endpoint checks
  assert.equal(
    (await call(`/schedules/photographer/${photo1Id}/calendar?from=2026-11-01&to=2026-11-30`)).status,
    401,
  );
  assert.equal(
    (await call(`/schedules/photographer/${photo1Id}/calendar?from=2026-11-01&to=2026-11-30`, photo1Id))
      .status,
    403,
  );
  assert.equal(
    (await call(`/schedules/photographer/${clientId}/calendar?from=2026-11-01&to=2026-11-30`, adminId))
      .status,
    404,
  );
  assert.equal(
    (await call('/schedules/photographer/not-an-id/calendar?from=2026-11-01&to=2026-11-30', adminId))
      .status,
    404,
  );
  assert.equal(
    (await call(`/schedules/photographer/${photo1Id}/calendar?from=2026-11-30&to=2026-11-01`, adminId))
      .status,
    400,
  );

  const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const calRes = await call(
    `/schedules/photographer/${photo1Id}/calendar?from=${from}&to=${to}`,
    adminId,
  );
  assert.equal(calRes.status, 200);
  const calBody = await calRes.json();
  assert.equal(calBody.data.length, 3);
  assert.equal(calBody.data[0].service, 'yearbook');
  assert.equal(calBody.data[0].role, 'lead');
  assert.equal(calBody.data[0].workflowBooking, 'wf-1');
  assert.equal(calBody.data[1].service, 'concept');
  assert.equal(calBody.data[1].role, 'support');
  assert.equal(calBody.data[1].conceptOrder, 'co-1');
  assert.equal(calBody.data[2].status, 'cancelled');
});
