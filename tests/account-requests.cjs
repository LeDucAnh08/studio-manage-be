// HTTP contract tests with isolated model doubles: no real database or customer data.
process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'isolated-test-secret';
require('ts-node/register/transpile-only');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const AccountRequest = require('../src/models/AccountRequest').default;

const identities = {
  '000000000000000000000001': {
    _id: '000000000000000000000001',
    roles: [0],
    isActive: true,
  },
  '000000000000000000000002': {
    _id: '000000000000000000000002',
    roles: [3],
    isActive: true,
  },
};

let requestRecord;
let createdUser;
let submittedRequest;

User.findById = (id) => ({ select: async () => identities[id] });
User.exists = async () => false;
User.collection.updateOne = async (_filter, update) => {
  createdUser = update.$setOnInsert;
  return { acknowledged: true, upsertedCount: createdUser ? 1 : 0 };
};

AccountRequest.exists = async () => false;
AccountRequest.create = async (data) => {
  submittedRequest = data;
  return data;
};
AccountRequest.findOneAndUpdate = (filter, update) => {
  if (update.$set?.reviewLockToken) {
    return {
      select: async () => {
        if (
          !requestRecord ||
          requestRecord._id !== filter._id ||
          requestRecord.status !== 'pending' ||
          (requestRecord.reviewLockExpiresAt && requestRecord.reviewLockExpiresAt > new Date())
        ) {
          return null;
        }
        Object.assign(requestRecord, update.$set);
        return requestRecord;
      },
    };
  }

  return Promise.resolve().then(() => {
    if (
      !requestRecord ||
      requestRecord._id !== filter._id ||
      requestRecord.status !== 'pending' ||
      requestRecord.reviewLockToken !== filter.reviewLockToken
    ) {
      return null;
    }
    Object.assign(requestRecord, update.$set);
    for (const field of Object.keys(update.$unset ?? {})) delete requestRecord[field];
    return requestRecord;
  });
};
AccountRequest.updateOne = async (filter, update) => {
  if (requestRecord?.reviewLockToken === filter.reviewLockToken) {
    for (const field of Object.keys(update.$unset ?? {})) delete requestRecord[field];
  }
  return { acknowledged: true };
};

test('Staff account requests are validated and reviewed once', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/account-requests', require('../src/routes/accountRequests').default);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, id, body, method = 'POST') =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(id ? { Authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET)}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const [admin, staff] = Object.keys(identities);

  await t.test('submission normalizes identity and cannot request an admin role', async () => {
    const accepted = await call('/account-requests', null, {
      username: ' New.Staff ',
      name: ' Nhân sự mới ',
      phone: '0901234567',
      password: 'test-pass-123',
      requestedRole: 3,
    });
    assert.equal(accepted.status, 201);
    assert.equal(submittedRequest.username, 'new.staff');
    assert.equal(submittedRequest.name, 'Nhân sự mới');
    assert.notEqual(submittedRequest.passwordHash, 'test-pass-123');

    assert.equal(
      (
        await call('/account-requests', null, {
          username: 'admin-request',
          name: 'Admin giả',
          password: 'test-pass-123',
          requestedRole: 0,
        })
      ).status,
      400,
    );
  });

  await t.test('staff cannot review and rejection requires a reason', async () => {
    requestRecord = {
      _id: '000000000000000000000010',
      username: 'pending.staff',
      name: 'Pending Staff',
      passwordHash: '$2b$12$test',
      requestedRole: 3,
      status: 'pending',
    };
    assert.equal(
      (await call(`/account-requests/${requestRecord._id}`, staff, { status: 'approved' }, 'PATCH'))
        .status,
      403,
    );
    assert.equal(
      (
        await call(
          `/account-requests/${requestRecord._id}`,
          admin,
          { status: 'rejected', note: '' },
          'PATCH',
        )
      ).status,
      400,
    );
  });

  await t.test('concurrent approvals create one user and one reviewer wins', async () => {
    requestRecord = {
      _id: '000000000000000000000011',
      username: 'approved.staff',
      name: 'Approved Staff',
      passwordHash: '$2b$12$test',
      requestedRole: 3,
      status: 'pending',
    };
    createdUser = null;
    const responses = await Promise.all(
      [1, 2].map(() =>
        call(
          `/account-requests/${requestRecord._id}`,
          admin,
          { status: 'approved', roles: [3], note: 'Đã xác minh' },
          'PATCH',
        ),
      ),
    );
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(requestRecord.status, 'approved');
    assert.equal(requestRecord.passwordHash, undefined);
    assert.equal(createdUser.username, 'approved.staff');
    assert.deepEqual(createdUser.roles, [3]);
    assert.equal(String(createdUser.sourceAccountRequest), requestRecord._id);
  });
});
