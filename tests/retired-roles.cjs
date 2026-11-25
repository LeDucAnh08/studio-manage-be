// Real HTTP boundaries with model doubles; no database or external service writes.
process.env.TS_NODE_PROJECT = require('node:path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'retired-role-test-only';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const AccountRequest = require('../src/models/AccountRequest').default;
const { shootOrdersScope } = require('../src/controllers/shootOrdersController');

test('retired roles cannot authenticate, be assigned, register, or escape photographer scope', async (t) => {
  const actors = {
    admin: [1],
    sale: [2],
    affiliate: [4],
    accountant: [5],
    legacyFinancePhoto: [3, 5],
    legacyPhoto: [2, 3],
    photo: [3],
    client: [6],
  };
  t.mock.method(User, 'findById', (id) => ({
    select: async () => ({ _id: id, roles: actors[id], isActive: true }),
  }));
  t.mock.method(User, 'findOne', () => ({
    select: async () => ({
      _id: 'sale',
      roles: [2],
      isActive: true,
      comparePassword: async () => true,
    }),
  }));
  let assigned;
  t.mock.method(User, 'find', (filter) => {
    assigned = filter;
    const query = { select: () => query, sort: async () => [] };
    return query;
  });
  t.mock.method(User, 'exists', () => ({ session: async () => null }));
  let writes = 0;
  t.mock.method(User, 'create', async () => {
    writes++;
  });
  t.mock.method(AccountRequest, 'create', async () => {
    writes++;
  });
  const app = express();
  app.use(express.json());
  app.use('/users', require('../src/routes/users').default);
  app.use('/auth', require('../src/routes/auth').default);
  app.use('/account-requests', require('../src/routes/accountRequests').default);
  app.use('/schedules', require('../src/routes/schedules').default);
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
  for (const actor of ['sale', 'affiliate', 'accountant'])
    for (const route of ['/auth/me', '/users/photographers', '/users/coordinators', '/schedules'])
      assert.equal((await call(route, actor)).status, 401, `${actor} ${route}`);
  assert.equal(
    (await call('/auth/login', null, 'POST', { username: 'old.sale', password: 'TestOnly123!' }))
      .status,
    401,
  );
  for (const role of [2, 4, 5]) {
    assert.equal(
      (
        await call('/users', 'admin', 'POST', {
          username: 'new.user',
          password: 'TestOnly123!',
          roles: [role],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call('/account-requests', null, 'POST', {
          username: 'new.user',
          name: 'Test User',
          password: 'TestOnly123!',
          requestedRole: role,
        })
      ).status,
      400,
    );
    assert.ok(
      new User({ username: 'bad.role', password: 'TestOnly123!', roles: [role] }).validateSync(),
    );
  }
  assert.equal(new User({ username: 'safe.default', password: 'TestOnly123!' }).roles[0], 6);
  assert.equal((await call('/users/coordinators', 'admin')).status, 200);
  assert.deepEqual(assigned, { roles: { $in: [0, 1] }, isActive: true });
  assert.equal((await call('/users/coordinators', 'photo')).status, 403);
  assert.equal((await call('/users/sales', 'admin')).status, 404);
  assert.equal(
    (await call('/schedules', 'admin', 'POST', { bookedBy: '000000000000000000000003' })).status,
    400,
  );
  const scope = shootOrdersScope({ roles: [2, 3, 5] });
  assert.equal(scope.yearbookAll, false);
  assert.equal(scope.conceptAll, false);
  assert.equal(scope.finance, false);
  assert.equal(writes, 0);
});

test('an old pending account request cannot recreate a retired role through review defaults', async (t) => {
  t.mock.method(User, 'findById', () => ({
    select: async () => ({ _id: 'admin', roles: [1], isActive: true }),
  }));
  let writes = 0,
    released = false;
  t.mock.method(User.collection, 'updateOne', async () => {
    writes++;
  });
  t.mock.method(AccountRequest, 'findOneAndUpdate', () => ({
    select: async () => ({
      _id: '000000000000000000000004',
      requestedRole: 5,
      passwordHash: 'test-hash',
    }),
  }));
  t.mock.method(AccountRequest, 'updateOne', async () => {
    released = true;
  });
  const app = express();
  app.use(express.json());
  app.use('/account-requests', require('../src/routes/accountRequests').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/account-requests/000000000000000000000004`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt.sign({ id: 'admin' }, process.env.JWT_SECRET)}`,
      },
      body: JSON.stringify({ status: 'approved' }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(writes, 0);
  assert.equal(released, true);
});
