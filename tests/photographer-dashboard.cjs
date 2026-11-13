process.env.TS_NODE_PROJECT = require('node:path').join(__dirname, '../tsconfig.json');
process.env.CONCEPT_BOOKING_ENABLED = 'true';
process.env.JWT_SECRET = 'photographer-dashboard-test';
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { photographerDashboard, dashboardRange } = require('../src/services/photographerDashboard');
const now = Date.parse('2026-11-13T02:00:00Z');
const row = (overrides = {}) => ({
  _id: 'base',
  service: 'yearbook',
  title: '12A1',
  packageName: 'Gói lớp',
  stage: 'confirmed',
  role: 'support',
  actualShoot: true,
  shootDate: '2026-11-19T00:00:00Z',
  startTime: '07:00',
  endTime: '11:00',
  ...overrides,
});

test('statistics use Vietnam dates, actual assignments, album review and real completion/deadline dates', () => {
  const rows = [
    ...Array.from({ length: 25 }, (_, index) => row({ _id: String(index) })),
    row({
      _id: 'first',
      shootDate: '2026-10-31T17:00:00Z',
      stage: 'completed',
      completedAt: '2026-11-10T00:00:00Z',
    }),
    row({ _id: 'last', shootDate: '2026-11-30T16:59:59Z', stage: 'completed' }),
    row({
      _id: 'prior-shoot',
      shootDate: '2026-10-01',
      stage: 'completed',
      completedAt: '2026-10-31T17:00:00Z',
    }),
    row({ _id: 'proposal', actualShoot: false }),
    row({ _id: 'cancelled', stage: 'cancelled' }),
    row({ _id: 'rejected', stage: 'rejected' }),
    row({ _id: 'overdue', stage: 'editing', deadline: '2026-11-12' }),
    row({ _id: 'due-today', stage: 'editing', deadline: '2026-11-13T00:00:00Z' }),
    row({
      _id: 'no-deadline',
      service: 'concept',
      actualShoot: false,
      role: 'editor',
      stage: 'editing',
      albumStatus: 'revising',
    }),
    row({
      _id: 'review-concept',
      service: 'concept',
      stage: 'editing',
      actualShoot: false,
      role: 'editor',
      albumStatus: 'delivered',
      deadline: '2026-11-01',
    }),
    row({ _id: 'accepted', stage: 'delivered', acceptedAt: '2026-11-12' }),
    row({ _id: 'review-yearbook', stage: 'delivered' }),
  ];
  const result = photographerDashboard(rows, 'month', now, 'overdue');
  assert.equal(result.counts.upcoming, 25, 'Counts are not capped at a list page');
  assert.equal(result.counts.completed, 2, 'Completion date, not shoot date or last update');
  assert.equal(result.counts.editing, 3);
  assert.equal(
    result.counts.review,
    2,
    'Delivered album awaits acceptance; an accepted yearbook does not',
  );
  assert.equal(result.counts.overdue, 1, 'Today and missing deadlines must not be overdue');
  assert.equal(result.detail.total, 1);
  assert.equal(result.detail.rows[0]._id, 'overdue');
  assert.equal(result.priority[0]._id, 'overdue');
  assert.equal(result.priority.at(-1)._id, 'no-deadline');
  assert.equal(
    result.chart.reduce((sum, bucket) => sum + bucket.concept + bucket.yearbook, 0),
    result.counts.shoots,
  );
  const page = photographerDashboard(rows, 'month', now, 'upcoming', 0, 2);
  assert.equal(page.detail.rows.length, 5);
  assert.equal(page.detail.total, 25);
  assert.equal(dashboardRange('month', now).start.toISOString(), '2026-10-31T17:00:00.000Z');
  assert.equal(dashboardRange('month', now).end.toISOString(), '2026-11-30T17:00:00.000Z');
  assert.equal(dashboardRange('previous', Date.parse('2027-01-01T01:00:00Z')).from, '2026-12-01');
  assert.equal(dashboardRange('quarter', now).from, '2026-10-01');
  assert.equal(photographerDashboard([], 'year', now).chart.length, 4);
  const detail = photographerDashboard(rows, 'month', now, 'group', 2);
  assert.equal(detail.detail.total, result.chart[2].concept + result.chart[2].yearbook);
});

test('photographer dashboard requires role 3 and scopes both service branches before statistics', async (t) => {
  const express = require('express'),
    jwt = require('jsonwebtoken');
  const User = require('../src/models/User').default;
  const Workflow = require('../src/models/BookingWorkflow').default;
  const Concept = require('../src/models/ConceptOrder').default;
  const Season = require('../src/models/Season').default;
  const photo = new Types.ObjectId(),
    mixed = new Types.ObjectId(),
    admin = new Types.ObjectId(),
    other = new Types.ObjectId();
  const users = Object.fromEntries(
    [
      [photo, [3]],
      [mixed, [3, 5]],
      [admin, [0]],
    ].map(([id, roles]) => [String(id), { _id: id, roles, isActive: true }]),
  );
  t.mock.method(User, 'findById', (id) => ({ select: async () => users[id] }));
  let pipeline;
  t.mock.method(Workflow, 'aggregate', async (value) => {
    pipeline = value;
    return [];
  });
  t.mock.method(Concept, 'aggregate', async (value) => {
    pipeline = value;
    return [];
  });
  t.mock.method(Season, 'findById', () => ({ select: () => ({ lean: async () => null }) }));
  const app = express();
  app.use('/dashboard', require('../src/routes/dashboard').default);
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
    fetch(`http://127.0.0.1:${server.address().port}/dashboard/photographer${query}`, {
      headers: id
        ? { Authorization: `Bearer ${jwt.sign({ id: String(id) }, process.env.JWT_SECRET)}` }
        : {},
    });
  assert.equal((await call()).status, 401);
  assert.equal((await call(admin)).status, 403);
  const response = await call(photo, '?userId=' + other);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.counts.shoots, 0);
  assert.deepEqual(pipeline[0].$match.$or, [
    { assignedPhotographer: photo },
    { assignedSupportPhotographers: photo },
    { 'resources.photographers': photo },
  ]);
  const branch = pipeline.find((step) => step.$unionWith).$unionWith.pipeline;
  assert.deepEqual(branch[0].$match, { $or: [{ photographer: photo }, { editor: photo }] });
  assert.ok(branch.some((step) => step.$lookup));
  assert.ok(!JSON.stringify(payload).includes('payments'));
  assert.equal((await call(mixed, '?service=concept&metric=completed')).status, 200);
  assert.deepEqual(pipeline[0].$match, { $or: [{ photographer: mixed }, { editor: mixed }] });
  for (const query of [
    '?period=all',
    '?service[$ne]=yearbook',
    '?metric=bad',
    '?page=0',
    '?page=2&page=3',
    '?season=bad',
    '?group=9',
  ])
    assert.equal((await call(photo, query)).status, 400);
  assert.equal((await call(photo, '?season=' + new Types.ObjectId())).status, 404);
});
