process.env.TS_NODE_PROJECT = require('node:path').join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'photographer-orders-test-secret';
process.env.CONCEPT_BOOKING_ENABLED = 'true';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Types } = require('mongoose');
const User = require('../src/models/User').default;
const Workflow = require('../src/models/BookingWorkflow').default;
const Concept = require('../src/models/ConceptOrder').default;

test('unified photographer list protects both service branches and filters/counts before pagination', async (t) => {
  const photographer = new Types.ObjectId();
  const other = new Types.ObjectId();
  const admin = new Types.ObjectId();
  const client = new Types.ObjectId();
  const mixed = new Types.ObjectId();
  const users = Object.fromEntries(
    [
      [photographer, [3]],
      [other, [3]],
      [admin, [0]],
      [client, [6]],
      [mixed, [3, 5]],
    ].map(([id, roles]) => [String(id), { _id: id, roles, isActive: true }]),
  );
  t.mock.method(User, 'findById', (id) => ({ select: async () => users[id] }));
  let pipeline, collection;
  const aggregate = (name) => async (value) => {
    pipeline = value;
    collection = name;
    return [{ data: [], count: [{ total: 45 }] }];
  };
  t.mock.method(Workflow, 'aggregate', aggregate('yearbook'));
  t.mock.method(Concept, 'aggregate', aggregate('concept'));
  const app = express();
  app.use('/workflows', require('../src/routes/workflows').default);
  app.use((error, req, res, next) =>
    res.status(error.status || 500).json({ message: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = (id, query = '') =>
    fetch(`http://127.0.0.1:${server.address().port}/workflows/photographer-orders${query}`, {
      headers: id
        ? { Authorization: `Bearer ${jwt.sign({ id: String(id) }, process.env.JWT_SECRET)}` }
        : {},
    });
  assert.equal((await call()).status, 401);
  assert.equal((await call(admin)).status, 403);
  assert.equal((await call(client)).status, 403);
  const response = await call(photographer, '?page=2&limit=20&stage=editing&photographer=' + other);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).pagination, { total: 45, page: 2, limit: 20 });
  assert.equal(collection, 'yearbook');
  assert.deepEqual(pipeline[0].$match.$or, [
    { assignedPhotographer: photographer },
    { assignedSupportPhotographers: photographer },
    { 'resources.photographers': photographer },
  ]);
  const unionIndex = pipeline.findIndex((step) => step.$unionWith);
  const union = pipeline[unionIndex].$unionWith;
  assert.equal(union.coll, Concept.collection.name);
  assert.deepEqual(union.pipeline[0].$match, { $or: [{ photographer }, { editor: photographer }] });
  const filterIndex = pipeline.findIndex((step) => step.$match?.stage);
  assert.ok(filterIndex > unionIndex, 'Status filter covers both services before pagination');
  assert.ok(
    !pipeline.some((step) => step.$skip || step.$limit),
    'No single-service pre-pagination',
  );
  assert.deepEqual(pipeline.at(-1).$facet, {
    data: [{ $sort: { updatedAt: -1, service: 1, _id: -1 } }, { $skip: 20 }, { $limit: 20 }],
    count: [{ $count: 'total' }],
  });
  for (const project of [
    pipeline.find((step) => step.$project).$project,
    union.pipeline.find((step) => step.$project).$project,
  ]) {
    assert.equal(project.payment, undefined);
    assert.equal(project.phone, undefined);
    assert.equal(project.payments, undefined);
    assert.ok(project.stage);
  }
  assert.equal((await call(mixed, '?service=concept')).status, 200);
  assert.equal(collection, 'concept');
  assert.deepEqual(
    pipeline[0].$match,
    { $or: [{ photographer: mixed }, { editor: mixed }] },
    'Accountant role cannot broaden photographer feed',
  );
  assert.ok(!pipeline.some((step) => step.$unionWith));
  assert.equal((await call(photographer, '?service=yearbook')).status, 200);
  assert.ok(!pipeline.some((step) => step.$unionWith));
  for (const query of [
    '?service=rentals',
    '?service[$ne]=yearbook',
    '?stage=unknown',
    '?page=0',
    '?page=2&page=3',
    '?limit=51',
    '?limit=NaN',
  ])
    assert.equal((await call(photographer, query)).status, 400);
  process.env.CONCEPT_BOOKING_ENABLED = 'false';
  assert.equal((await call(photographer)).status, 200);
  assert.ok(!pipeline.some((step) => step.$unionWith));
  assert.equal((await call(photographer, '?service=concept')).status, 400);
});
