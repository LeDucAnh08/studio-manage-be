process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'isolated-class-students-test';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../src/models/User').default;
const Customer = require('../src/models/Customer').default;
const BookingWorkflow = require('../src/models/BookingWorkflow').default;
const Student = require('../src/models/Student').default;

test('class roster keeps existing role permissions and reads only that class booking members', async (t) => {
  const id = '000000000000000000000001';
  let exists = true;
  let workflow = {
    members: [
      {
        _id: 'member-1',
        name: 'Học sinh đặt dịch vụ',
        contact: '0901234567',
        height: 165,
        weight: 52,
        pantsSize: 'M',
        shirtSize: 'L',
        notes: 'Ghi chú riêng',
        requestId: 'private-request',
        requestFingerprint: 'private-fingerprint',
      },
    ],
  };
  let legacyReads = 0;
  let reads = 0;
  t.mock.method(User, 'findById', (role) => ({
    select: async () => ({ _id: id, roles: [Number(role)], isActive: true }),
  }));
  t.mock.method(Customer, 'exists', async (query) => {
    reads++;
    assert.deepEqual(query, { _id: id });
    return exists;
  });
  t.mock.method(BookingWorkflow, 'findOne', (query) => {
    assert.deepEqual(query, { customer: id });
    return {
      select: (fields) => {
        assert.equal(fields, 'members');
        return { lean: async () => workflow };
      },
    };
  });
  t.mock.method(Student, 'find', (query) => {
    legacyReads++;
    assert.deepEqual(query, { customer: id });
    const chain = {
      select: () => chain,
      sort: () => chain,
      lean: async () =>
        Array.from({ length: 65 }, (_, index) => ({
          _id: `legacy-${index}`,
          name: `Học sinh ${index}`,
          shirtSize: 'M',
        })),
    };
    return chain;
  });
  const app = express();
  app.use('/customers', require('../src/routes/customers').default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = (role, customer = id) =>
    fetch(`http://127.0.0.1:${server.address().port}/customers/${customer}/students`, {
      headers:
        role === undefined
          ? {}
          : {
              Authorization: `Bearer ${jwt.sign({ id: String(role) }, process.env.JWT_SECRET, { expiresIn: '1h' })}`,
            },
    });
  assert.equal((await get()).status, 401);
  for (const role of [3, 5, 6]) assert.equal((await get(role)).status, 403);
  assert.equal(reads, 0);
  for (const role of [0, 1, 2, 4]) {
    const result = await get(role);
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).data, {
      source: 'booking',
      students: [
        {
          _id: 'member-1',
          name: 'Học sinh đặt dịch vụ',
          contact: '0901234567',
          height: 165,
          weight: 52,
          pantsSize: 'M',
          shirtSize: 'L',
          notes: 'Ghi chú riêng',
        },
      ],
    });
  }
  assert.equal(legacyReads, 0);
  workflow = { members: [] };
  assert.deepEqual((await (await get(0)).json()).data.students, []);
  assert.equal(legacyReads, 0);
  workflow = null;
  const legacy = (await (await get(0)).json()).data;
  assert.equal(legacy.source, 'legacy');
  assert.equal(legacy.students.length, 65);
  assert.equal(legacy.students[64].name, 'Học sinh 64');
  exists = false;
  assert.equal((await get(0)).status, 404);
  assert.equal((await get(0, 'invalid')).status, 400);
});
