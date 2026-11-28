process.env.TS_NODE_PROJECT = require('node:path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'transactions-finance-test-secret';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Transaction = require('../src/models/Transaction').default;

test('transactions getAll supports search, refundStatus, sort and returns filtered totals', async (t) => {
  const adminId = '000000000000000000000001';
  const adminUser = { _id: adminId, roles: [1], isActive: true };
  t.mock.method(User, 'findById', (id) => {
    const user = String(id) === adminId ? adminUser : null;
    return {
      select: () => Object.assign(Promise.resolve(user), { lean: async () => user }),
    };
  });

  let capturedFilter;
  let capturedSort;
  t.mock.method(Transaction, 'find', (filter) => {
    capturedFilter = filter;
    const query = {
      populate: () => query,
      sort: (sortObj) => {
        capturedSort = sortObj;
        return query;
      },
      skip: () => query,
      limit: () => query,
      lean: async () => [
        {
          _id: 'tx-1',
          type: 'expense',
          amount: 250000,
          description: 'Mua nước ekip',
          date: '2026-11-26T00:00:00Z',
          accountantRefunded: false,
        },
      ],
    };
    return query;
  });
  t.mock.method(Transaction, 'countDocuments', async () => 1);
  t.mock.method(Transaction, 'aggregate', async () => [
    {
      _id: null,
      income: 800000,
      incomeCount: 1,
      expense: 250000,
      expenseCount: 1,
      unrefundedAmount: 250000,
      unrefundedCount: 1,
    },
  ]);

  const app = express();
  app.use('/transactions', require('../src/routes/transactions').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const token = jwt.sign({ id: adminId }, process.env.JWT_SECRET);
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/transactions?search=ekip&refundStatus=unrefunded&sort=date_asc&dateTo=2026-11-26`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(capturedFilter.type, 'expense');
  assert.deepEqual(capturedFilter.accountantRefunded, { $ne: true });
  assert.deepEqual(capturedFilter.description, { $regex: 'ekip', $options: 'i' });
  assert.equal(capturedFilter.date.$lte.toISOString(), '2026-11-26T23:59:59.999Z');
  assert.deepEqual(capturedSort, { date: 1, _id: 1 });
  assert.deepEqual(body.pagination.totals, {
    income: 800000,
    incomeCount: 1,
    expense: 250000,
    expenseCount: 1,
    profit: 550000,
    unrefundedAmount: 250000,
    unrefundedCount: 1,
  });
});
