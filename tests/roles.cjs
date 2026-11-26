const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'role-reference-test-only';
require('ts-node/register/transpile-only');

const express = require('express');
const jwt = require('jsonwebtoken');
const Role = require('../src/models/Role').default;
const { ACTIVE_ROLES } = require('../src/models/Role');
const User = require('../src/models/User').default;
const AccountRequest = require('../src/models/AccountRequest').default;
const { ensureRoles } = require('../src/services/roles');

test('numeric role references preserve existing account values and reject retired IDs', async (t) => {
  for (const role of [2, 4, 5, 7]) {
    assert.ok(new Role({ _id: role, name: 'Invalid role' }).validateSync());
    assert.ok(
      new User({ username: 'test', password: 'test-password', roles: [role] }).validateSync(),
    );
  }
  for (const role of ACTIVE_ROLES)
    assert.equal(new Role({ _id: role, name: `Role ${role}` }).validateSync(), undefined);
  assert.equal(
    new AccountRequest({ requestedRole: 1 }).validateSync().errors.requestedRole.kind,
    'enum',
  );
  const user = new User({ username: 'test', password: 'test-password', roles: [1, 3] });
  assert.equal(user.validateSync(), undefined);
  assert.deepEqual(user.toObject().roles, [1, 3]);
  assert.deepEqual(
    new User({ username: 'client', password: 'test-password' }).toObject().roles,
    [6],
  );

  t.mock.method(Role, 'find', (filter) => {
    assert.deepEqual(filter._id.$in, [1, 3]);
    return {
      exec: async () => [
        new Role({ _id: 1, name: 'Admin' }),
        new Role({ _id: 3, name: 'Thợ chụp ảnh' }),
      ],
    };
  });
  await user.populate('roles');
  assert.deepEqual(
    user.roles.map((role) => role.name),
    ['Admin', 'Thợ chụp ảnh'],
  );
});

test('initialization adds only missing roles and preserves existing metadata on repeated runs', async (t) => {
  const existing = {
    _id: 1,
    name: 'Existing name',
    description: 'Existing description',
    updatedAt: new Date(0),
  };
  const records = new Map([[1, existing]]);
  t.mock.method(Role, 'bulkWrite', async (operations) => {
    let upsertedCount = 0;
    for (const { updateOne: operation } of operations) {
      assert.equal(operation.timestamps, false);
      assert.deepEqual(Object.keys(operation.update), ['$setOnInsert']);
      if (!records.has(operation.filter._id)) {
        records.set(operation.filter._id, operation.update.$setOnInsert);
        upsertedCount++;
      }
    }
    return { upsertedCount };
  });
  assert.equal(await ensureRoles(), 3);
  const snapshot = structuredClone([...records.values()]);
  assert.equal(await ensureRoles(), 0);
  assert.deepEqual([...records.values()], snapshot);
  assert.deepEqual(records.get(1), existing);
  assert.deepEqual([...records.keys()].sort(), [0, 1, 3, 6]);
});

test('role catalog is database-backed, admin-only and read-only; login keeps numeric roles', async (t) => {
  const roles = ACTIVE_ROLES.map((_id) => ({
    _id,
    name: `Stored role ${_id}`,
    description: 'From database',
  }));
  const actors = { superadmin: [0], admin: [1], photographer: [3], customer: [6], retired: [5] };
  t.mock.method(User, 'findById', (id) => ({
    select: async () => ({ _id: id, username: id, roles: actors[id], isActive: true }),
  }));
  t.mock.method(User, 'findOne', () => ({
    select: async () => ({
      _id: 'admin',
      username: 'admin',
      roles: [1, 3],
      isActive: true,
      comparePassword: async () => true,
    }),
  }));
  t.mock.method(Role, 'find', (filter) => {
    assert.deepEqual(filter, { _id: { $in: [0, 1, 3, 6] } });
    return { select: () => ({ sort: () => ({ lean: async () => roles }) }) };
  });
  const app = express();
  app.use(express.json());
  app.use('/roles', require('../src/routes/roles').default);
  app.use('/auth', require('../src/routes/auth').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const call = (route, actor, method = 'GET', body) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(actor
          ? { Authorization: `Bearer ${jwt.sign({ id: actor }, process.env.JWT_SECRET)}` }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await call('/roles')).status, 401);
  assert.equal((await call('/roles', 'retired')).status, 401);
  for (const actor of ['photographer', 'customer'])
    assert.equal((await call('/roles', actor)).status, 403);
  for (const actor of ['superadmin', 'admin']) {
    const response = await call('/roles', actor);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, roles);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    assert.equal((await call('/roles', 'admin', method, { _id: 2 })).status, 404);
  const login = await call('/auth/login', null, 'POST', {
    username: 'admin',
    password: 'test-password',
  });
  assert.equal(login.status, 200);
  const payload = (await login.json()).data;
  assert.deepEqual(payload.user.roles, [1, 3]);
  assert.equal(jwt.verify(payload.token, process.env.JWT_SECRET).id, 'admin');
});
