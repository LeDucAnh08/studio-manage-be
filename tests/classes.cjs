const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const Class = require('../src/models/Class').default;

test('Class uses classes and all existing customer relations populate it without changing IDs', async (t) => {
  assert.equal(Class.modelName, 'Class');
  assert.equal(Class.collection.collectionName, 'classes');
  assert.equal(mongoose.models.Customer, undefined);
  for (const name of ['Student', 'Schedule', 'BookingWorkflow', 'Transaction', 'Feedback']) {
    const model = require(`../src/models/${name}`).default;
    assert.equal(model.schema.path('customer').options.ref, 'Class', name);
  }
  const id = new mongoose.Types.ObjectId();
  const schoolClass = new Class({ _id: id, className: '12A1', school: 'Trường kiểm thử' });
  t.mock.method(Class, 'find', (filter) => {
    assert.deepEqual(filter._id.$in, [id]);
    return { exec: async () => [schoolClass] };
  });
  const Student = require('../src/models/Student').default;
  const student = new Student({ customer: id, name: 'Học sinh kiểm thử' });
  await student.populate('customer');
  assert.equal(String(student.customer._id), String(id));
  assert.equal(student.customer.className, '12A1');
});

test('transaction summary joins classes while preserving the customer-shaped API result', async (t) => {
  const Transaction = require('../src/models/Transaction').default;
  const { getSummary } = require('../src/controllers/transactionController');
  const rows = [{ customer: { className: '12A1' }, income: 100, expense: 20, profit: 80 }];
  t.mock.method(Transaction, 'aggregate', async (pipeline) => {
    assert.equal(pipeline.find((stage) => stage.$lookup).$lookup.from, 'classes');
    return rows;
  });
  let payload;
  await getSummary(
    { query: {}, user: { roles: [1] } },
    {
      status: (status) => {
        assert.equal(status, 200);
        return {
          json: (body) => {
            payload = body;
          },
        };
      },
    },
  );
  assert.deepEqual(payload.data, rows);
});
