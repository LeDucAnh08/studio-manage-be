// Isolated HTTP checks: no database connection or rental records created.
process.env.TS_NODE_PROJECT = require('node:path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'rental-access-test-secret';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const RentalOrder = require('../src/models/RentalOrder').default;
const { resourceTransactionsRequired } = require('../src/services/workflowTransactions');

test('rentals are open by default and ignore the removed switch while enforcing access and validation', async (t) => {
  const clientId = '000000000000000000000001';
  const adminId = '000000000000000000000002';
  const photographerId = '000000000000000000000003';
  const users = {
    [clientId]: { _id: clientId, roles: [6], isActive: true },
    [adminId]: { _id: adminId, roles: [0], isActive: true },
    [photographerId]: { _id: photographerId, roles: [3], isActive: true },
  };
  t.mock.method(User, 'findById', (id) => ({ select: async () => users[id] }));
  let lastFilter;
  t.mock.method(RentalOrder, 'find', (filter) => {
    lastFilter = filter;
    const query = {
      sort: () => query,
      skip: () => query,
      limit: () => query,
      lean: async () => [],
    };
    return query;
  });
  t.mock.method(RentalOrder, 'countDocuments', async () => 0);
  delete process.env.CLIENT_PORTAL_ENABLED;
  const app = express();
  app.use(express.json());
  app.use('/rentals', require('../src/routes/rentals').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = (id, method = 'GET', query = '') =>
    fetch(`http://127.0.0.1:${server.address().port}/rentals${query}`, {
      method,
      headers: {
        ...(id ? { Authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET)}` } : {}),
        ...(method === 'POST'
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-rental-access' }
          : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
  for (const obsoleteValue of [undefined, 'false', 'true']) {
    if (obsoleteValue === undefined) delete process.env.CLIENT_RENTAL_ENABLED;
    else process.env.CLIENT_RENTAL_ENABLED = obsoleteValue;
    assert.equal((await call(clientId)).status, 200);
    assert.deepEqual(lastFilter, { client: clientId });
    assert.equal((await call(clientId, 'POST')).status, 400, 'Request reaches input validation');
    assert.equal(
      await resourceTransactionsRequired(),
      true,
      'Default-open portal protects the first inventory hold',
    );
  }
  assert.equal((await call()).status, 401);
  for (const view of ['active', 'completed', 'cancelled', 'rejected']) {
    assert.equal((await call(clientId, 'GET', `?page=2&view=${view}`)).status, 200);
    assert.equal(lastFilter.client, clientId, 'Status filtering must preserve customer ownership');
    assert.deepEqual(
      lastFilter.status,
      view === 'active'
        ? {
            $in: [
              'requested',
              'quoting',
              'awaiting_deposit',
              'ready_to_confirm',
              'confirmed',
              'checked_out',
              'returned',
            ],
          }
        : view,
    );
  }
  for (const query of ['?view=unknown', '?view[$ne]=completed', '?view=active&view=completed'])
    assert.equal((await call(clientId, 'GET', query)).status, 400);
  assert.equal((await call(photographerId)).status, 403);
  assert.equal(
    (await call(adminId, 'POST')).status,
    403,
    'Only clients can create rental requests',
  );
  process.env.CLIENT_PORTAL_ENABLED = 'false';
  assert.equal((await call(clientId)).status, 503, 'The shared portal control still applies');
});
