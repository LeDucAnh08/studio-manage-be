// Read-only DTO projections with isolated model doubles; no database writes.
process.env.TS_NODE_PROJECT = require('node:path').join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Package = require('../src/models/Package').default;
const Costume = require('../src/models/Costume').default;
const User = require('../src/models/User').default;
const Schedule = require('../src/models/Schedule').default;
const BookingWorkflow = require('../src/models/BookingWorkflow').default;
const RentalOrder = require('../src/models/RentalOrder').default;
const { workflowListRows } = require('../src/controllers/workflowController');
const { listRentals } = require('../src/controllers/rentalController');
const query = data => { const chain = { select: () => chain, session: () => chain, sort: () => chain, skip: () => chain, limit: () => chain, lean: async () => data }; return chain; };

test('booking thumbnails use linked package IDs, not duplicate package names, in one query', async t => {
  const actor = { _id: 'client-1', roles: [6] };
  const bookings = ['package-a', 'package-b', 'legacy'].map((id, i) => ({ _id: 'booking-' + i, package: id, packageName: 'Tên gói giống nhau', client: actor._id, status: 'pending' }));
  let reads = 0;
  t.mock.method(Package, 'find', filter => {
    reads++;
    assert.deepEqual(filter, { _id: { $in: ['package-a', 'package-b', 'legacy'] } });
    return query([{ _id: 'package-b', details: { gallery: [{ id: 'image-b' }] } }, { _id: 'package-a', details: { gallery: [{ id: 'image-a' }] } }]);
  });
  t.mock.method(BookingWorkflow, 'find', () => query([]));
  t.mock.method(Schedule, 'find', () => query([]));
  t.mock.method(User, 'find', () => query([]));
  const rows = await workflowListRows(bookings, actor);
  assert.equal(reads, 1);
  assert.deepEqual(rows.map(row => row.thumbnailUrl), ['/api/media/packages/image-a', '/api/media/packages/image-b', undefined]);
  assert.ok(rows.every(row => row.packageName === 'Tên gói giống nhau'));
});

test('rental thumbnails follow the displayed accepted lines and keep the owner filter', async t => {
  const base = { version: 1, status: 'requested', requestedLines: [{ costumeId: 'costume-a' }], quote: null, quoteHistory: [], payments: [], returns: [], events: [] };
  const rows = [{ ...base, _id: 'rental-a' }, { ...base, _id: 'rental-c', requestedLines: [{ costumeId: 'costume-b' }], quote: { lines: [{ costumeId: 'costume-c' }] } }];
  t.mock.method(RentalOrder, 'find', filter => { assert.deepEqual(filter, { client: 'owner' }); return query(rows); });
  t.mock.method(RentalOrder, 'countDocuments', async () => 2);
  let reads = 0;
  t.mock.method(Costume, 'find', filter => { reads++; assert.deepEqual(filter._id.$in, ['costume-a', 'costume-c']); return query([{ _id: 'costume-c', imageUrl: '/costume-c.webp' }, { _id: 'costume-a', imageUrl: '/costume-a.webp' }]); });
  let body;
  await listRentals({ query: {}, user: { _id: 'owner', roles: [6] } }, { json: data => { body = data; } });
  assert.equal(reads, 1);
  assert.deepEqual(body.data.map(row => row.thumbnailUrl), ['/costume-a.webp', '/costume-c.webp']);
  assert.equal(body.pagination.total, 2);
});
