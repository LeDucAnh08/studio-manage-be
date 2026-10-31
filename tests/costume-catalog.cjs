process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Costume = require('../src/models/Costume').default;
const RentalOrder = require('../src/models/RentalOrder').default;
const Schedule = require('../src/models/Schedule').default;
const Booking = require('../src/models/Booking').default;
const costumeController = require('../src/controllers/costumeController');
const { readCostumeCatalogFilters, readCostumeInput } = require('../src/utils/costumeInput');
const { readRentalPeriod, rentalDays, vietnamDay } = require('../src/utils/rentalPeriod');
const {
  getRentalAvailability,
  ensureRentalAvailability,
  ensureRentalStockPreserved,
} = require('../src/services/rentalAvailability');

const query = (rows) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  sort() {
    return this;
  },
  session() {
    return this;
  },
  lean: async () => rows,
});
const mockHolds = (t, orders = [], schedules = []) => {
  t.mock.method(Booking, 'find', () => query([]));
  t.mock.method(RentalOrder, 'find', () => query(orders));
  t.mock.method(Schedule, 'find', () => query(schedules));
};
const period = (receiveDate = '2090-02-01', returnDate = '2090-02-03') =>
  readRentalPeriod(receiveDate, returnDate);
const catalogRequest = async (queryString) => {
  let payload;
  const res = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  await costumeController.getPublicCatalog({ query: queryString }, res);
  return { status: res.statusCode, payload };
};

test('costume input accepts catalog fields and returns only allowed data', () => {
  const parsed = readCostumeInput({
    name: '  Áo dài  ',
    itemKind: 'clothing',
    isRentalItem: true,
    rentalPrice: '150000',
    inventory: [{ size: 'M', quantity: '3', condition: 'good' }],
    createdAt: 'ignored only if rejected',
  });
  assert.equal(parsed.ok, false);

  const safe = readCostumeInput({
    name: '  Áo dài  ',
    itemKind: 'clothing',
    isRentalItem: true,
    rentalPrice: '150000',
    inventory: [{ size: 'M', quantity: '3', condition: 'good' }],
  });
  assert.equal(safe.ok, true);
  assert.deepEqual(safe.value, {
    name: 'Áo dài',
    itemKind: 'clothing',
    isRentalItem: true,
    rentalPrice: 150000,
    inventory: [{ size: 'M', quantity: 3, condition: 'good' }],
  });
});

test('costume input rejects negative, fractional, and non-numeric prices or quantities', () => {
  for (const invalid of [-1, 1.5, null, false, {}, '']) {
    assert.equal(readCostumeInput({ name: 'Áo dài', rentalPrice: invalid }).ok, false);
  }
  for (const invalid of [-1, 2.5, null, false, {}]) {
    assert.equal(
      readCostumeInput({ name: 'Áo dài', inventory: [{ size: 'M', quantity: invalid }] }).ok,
      false,
    );
  }
});

test('costume input rejects invalid sizes, duplicate stock rows, and mass assignment', () => {
  assert.equal(readCostumeInput({ name: 'Áo dài', gender: ['male'] }).ok, false);
  assert.equal(
    readCostumeInput({ name: 'Áo dài', inventory: [{ size: 'XXS', quantity: 1 }] }).ok,
    false,
  );
  assert.equal(
    readCostumeInput({
      name: 'Áo dài',
      inventory: [
        { size: 'M', quantity: 1, condition: 'good' },
        { size: 'M', quantity: 2, condition: 'good' },
      ],
    }).ok,
    false,
  );
  assert.equal(readCostumeInput({ name: 'Áo dài', roles: [0] }).ok, false);
  assert.equal(
    readCostumeInput({ name: 'Áo dài', inventory: [{ size: 'M', quantity: 1, _id: 'custom' }] }).ok,
    false,
  );
});

test('public catalog filters accept valid ranges and reject invalid filters', () => {
  assert.deepEqual(
    readCostumeCatalogFilters({
      itemKind: 'accessory',
      categoryId: '000000000000000000000099',
      size: 'FREE',
      minPrice: '0',
      maxPrice: '50000',
    }),
    {
      ok: true,
      value: {
        itemKind: 'accessory',
        categoryId: '000000000000000000000099',
        size: 'FREE',
        minPrice: 0,
        maxPrice: 50000,
      },
    },
  );
  assert.equal(readCostumeCatalogFilters({ categoryId: 'bad' }).ok, false);
  assert.equal(readCostumeCatalogFilters({ size: 'XXS' }).ok, false);
  assert.equal(readCostumeCatalogFilters({ minPrice: -1 }).ok, false);
  assert.equal(readCostumeCatalogFilters({ minPrice: null }).ok, false);
  assert.equal(readCostumeCatalogFilters({ minPrice: 500, maxPrice: 100 }).ok, false);
});

test('public catalog filters daily prices and exposes only safe availability fields', async (t) => {
  let findFilter;
  mockHolds(t);
  t.mock.method(Costume, 'find', (filter) => {
    findFilter = filter;
    const query = {
      select() {
        return this;
      },
      populate() {
        return this;
      },
      sort() {
        return this;
      },
      lean: async () => [
        {
          _id: '000000000000000000000001',
          name: 'Nón tốt nghiệp',
          imageUrl: '/costume-demo/graduationCap.webp',
          description: 'Màu xanh',
          gender: 'unisex',
          itemKind: 'accessory',
          type: { _id: '000000000000000000000099', name: 'Đạo cụ', privateField: 'not public' },
          rentalPrice: 50000,
          rentalDailyPrice: 20000,
          inventory: [
            { size: 'FREE', quantity: 5, condition: 'good' },
            { size: 'FREE', quantity: 1, condition: 'repair' },
            { size: 'M', quantity: 0, condition: 'good' },
          ],
          createdAt: new Date(),
          privateNote: 'not public',
        },
      ],
    };
    return query;
  });

  const app = express();
  app.get('/costumes', costumeController.getPublicCatalog);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/costumes?receiveDate=2090-02-01&returnDate=2090-02-03&itemKind=accessory&categoryId=000000000000000000000099&size=FREE&minPrice=10000&maxPrice=80000`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(findFilter, {
    isRentalItem: true,
    itemKind: 'accessory',
    type: '000000000000000000000099',
    inventory: { $elemMatch: { size: 'FREE', quantity: { $gt: 0 }, condition: 'good' } },
    rentalDailyPrice: { $gte: 10000, $lte: 80000, $gt: 0 },
  });
  const payload = await response.json();
  assert.deepEqual(payload.data, [
    {
      _id: '000000000000000000000001',
      name: 'Nón tốt nghiệp',
      imageUrl: '/costume-demo/graduationCap.webp',
      description: 'Màu xanh',
      gender: 'unisex',
      itemKind: 'accessory',
      categoryId: '000000000000000000000099',
      category: 'Đạo cụ',
      rentalPrice: 50000,
      rentalDailyPrice: 20000,
      rentalDays: 3,
      availableBySize: { FREE: 5 },
      sizes: ['FREE'],
    },
  ]);
});

test('legacy clothing keeps its flat price, has no guessed daily price and requires available stock', async (t) => {
  let findFilter;
  mockHolds(t);
  t.mock.method(Costume, 'find', (filter) => {
    findFilter = filter;
    return {
      select() {
        return this;
      },
      populate() {
        return this;
      },
      sort() {
        return this;
      },
      lean: async () => [
        {
          _id: '000000000000000000000002',
          name: 'Áo dài cũ',
          gender: 'female',
          type: null,
          rentalPrice: 175000,
          inventory: [{ size: 'M', quantity: 1, condition: 'good' }],
        },
      ],
    };
  });

  let response;
  const res = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      response = body;
      return this;
    },
  };
  await costumeController.getPublicCatalog(
    {
      query: {
        itemKind: 'clothing',
        receiveDate: '2090-02-01',
        returnDate: '2090-02-03',
      },
    },
    res,
  );

  assert.deepEqual(findFilter.itemKind, { $in: ['clothing', null] });
  assert.equal(res.statusCode, 200);
  assert.equal(response.data[0].itemKind, 'clothing');
  assert.equal(response.data[0].rentalPrice, 175000);
  assert.equal(response.data[0].rentalDailyPrice, null);
  assert.deepEqual(response.data[0].availableBySize, { M: 1 });
});

test('daily pricing is additive, nullable and strictly positive when configured', async () => {
  for (const invalid of [0, -1, 1.5, false, {}, '', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(readCostumeInput({ rentalDailyPrice: invalid }, true).ok, false);
  }
  assert.deepEqual(readCostumeInput({ rentalDailyPrice: null }, true), {
    ok: true,
    value: { rentalDailyPrice: null },
  });
  assert.deepEqual(readCostumeInput({ rentalDailyPrice: '150000' }, true), {
    ok: true,
    value: { rentalDailyPrice: 150000 },
  });
  const oldCostume = new Costume({ name: 'Áo dài', rentalPrice: 90000 });
  assert.equal(oldCostume.rentalDailyPrice, null);
  assert.equal(oldCostume.rentalPrice, 90000);
  for (const invalid of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    const model = new Costume({ name: 'Áo dài', rentalDailyPrice: invalid });
    assert.ok(model.validateSync()?.errors.rentalDailyPrice);
  }
});

test('rental periods validate strict dates, leap years, inclusive days and Vietnam midnight', () => {
  const leap = readRentalPeriod('2088-02-28', '2088-03-01', false);
  assert.equal(leap.rentalDays, 3);
  assert.equal(leap.receiveDate.toISOString(), '2088-02-27T17:00:00.000Z');
  assert.equal(rentalDays('2090-01-31', '2090-02-01'), 2);
  assert.equal(readRentalPeriod('2088-01-01', '2088-12-31', false).rentalDays, 366);
  assert.equal(rentalDays('2090-01-01T16:59:00Z', '2090-01-01T17:00:00Z'), 2);
  for (const dates of [
    ['2090-02-29', '2090-03-01'],
    ['2090-04-31', '2090-05-01'],
    ['2090-00-10', '2090-01-10'],
    ['2090-13-01', '2091-01-01'],
    ['2090-2-01', '2090-02-03'],
    ['2090-02-01T00:00:00Z', '2090-02-03'],
    [null, '2090-02-01'],
    [['2090-02-01'], '2090-02-03'],
    ['2090-02-03', '2090-02-02'],
    ['2088-01-01', '2089-01-01'],
  ])
    assert.throws(() => readRentalPeriod(...dates, false), { status: 400 });
  assert.throws(() => readRentalPeriod('2000-01-01', '2000-01-02'), { status: 400 });
  const today = vietnamDay(new Date());
  const todayString = new Date(today.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  assert.equal(readRentalPeriod(todayString, todayString).rentalDays, 1);
});

const id = '000000000000000000000001';
const stock = {
  _id: id,
  isRentalItem: true,
  inventory: [
    { size: 'M', condition: 'good', quantity: 3 },
    { size: 'L', condition: 'good', quantity: 1 },
    { size: 'M', condition: 'repair', quantity: 10 },
  ],
};
const order = (start, end, quantity = 2, status = 'confirmed', size = 'M') => ({
  status,
  quote: { ...readRentalPeriod(start, end, false), lines: [{ costumeId: id, size, quantity }] },
});
const schedule = (start, end, quantity = 1, size = 'M') => ({
  status: 'confirmed',
  costumes: [id],
  shootDate: start,
  costumeReservations: [{ costume: id, size, quantity, ...readRentalPeriod(start, end, false) }],
});

test('availability uses peak per day, inclusive overlap and only good stock', () => {
  const orders = [order('2090-02-01', '2090-02-01'), order('2090-02-03', '2090-02-03')];
  assert.deepEqual(getRentalAvailability(stock, period(), orders, []), { M: 1, L: 1 });
  assert.deepEqual(
    getRentalAvailability(stock, period(), [...orders, order('2090-02-01', '2090-02-02', 1)], []),
    { L: 1 },
  );
  assert.deepEqual(
    getRentalAvailability(
      stock,
      period(),
      [
        order('2090-02-01', '2090-02-03', 100, 'pending'),
        order('2090-02-01', '2090-02-03', 100, 'returned'),
      ],
      [],
    ),
    { M: 3, L: 1 },
  );
});

test('availability combines schedules, ignores cancelled holds and blocks unreconciled legacy days', () => {
  assert.deepEqual(
    getRentalAvailability(
      stock,
      period(),
      [order('2090-02-01', '2090-02-03')],
      [schedule('2090-02-02', '2090-02-04')],
    ),
    { L: 1 },
  );
  assert.deepEqual(
    getRentalAvailability(
      stock,
      period(),
      [],
      [{ ...schedule('2090-02-01', '2090-02-03', 100), status: 'cancelled' }],
    ),
    { M: 3, L: 1 },
  );
  const legacy = {
    status: 'completed',
    costumes: [id],
    shootDate: '2090-02-02',
    costumeReservations: [],
  };
  assert.deepEqual(getRentalAvailability(stock, period(), [], [legacy]), {});
  assert.deepEqual(getRentalAvailability(stock, period('2090-02-03', '2090-02-03'), [], [legacy]), {
    M: 3,
    L: 1,
  });
  assert.deepEqual(
    getRentalAvailability(stock, period(), [], [{ ...legacy, costumes: ['another'] }]),
    { M: 3, L: 1 },
  );
});

test('overdue checked-out garments remain held until returned, including future catalog dates', () => {
  const today = vietnamDay('2090-02-02');
  const overdue = order('2090-01-01', '2090-02-01', 3, 'checked_out');
  assert.deepEqual(getRentalAvailability(stock, period(), [overdue], [], today), { L: 1 });
  assert.deepEqual(
    getRentalAvailability(stock, period('2090-06-01', '2090-06-01'), [overdue], [], today),
    { L: 1 },
  );
  assert.deepEqual(
    getRentalAvailability(stock, period(), [{ ...overdue, status: 'returned' }], [], today),
    { M: 3, L: 1 },
  );
});

test('public catalog rejects missing or invalid periods before querying inventory', async (t) => {
  t.mock.method(Costume, 'find', () => {
    throw new Error('must not query');
  });
  for (const input of [
    {},
    { receiveDate: '2090-02-30', returnDate: '2090-03-01' },
    {
      receiveDate: '2000-01-01',
      returnDate: '2000-01-02',
    },
  ])
    assert.equal((await catalogRequest(input)).status, 400);
});

test('public catalog hides unavailable products and applies selected-size availability across the interval', async (t) => {
  mockHolds(t, [order('2090-02-02', '2090-02-03', 3)]);
  t.mock.method(Costume, 'find', () =>
    query([
      { ...stock, name: 'Áo dài', rentalPrice: 150000 },
      { _id: '000000000000000000000002', name: 'Hết hàng', inventory: [] },
    ]),
  );
  const input = { receiveDate: '2090-02-01', returnDate: '2090-02-03' };
  const all = await catalogRequest(input);
  assert.deepEqual(
    all.payload.data.map((row) => row.availableBySize),
    [{ L: 1 }],
  );
  assert.deepEqual((await catalogRequest({ ...input, size: 'M' })).payload.data, []);
});

test('confirmation shares catalog availability, aggregates duplicate lines and batches reads', async (t) => {
  mockHolds(t, [order('2090-02-02', '2090-02-03', 2)]);
  const reads = t.mock.method(Costume, 'find', () => query([stock]));
  const quoted = {
    ...period(),
    lines: [{ costumeId: id, size: 'M', name: 'Áo dài', quantity: 1 }],
  };
  await ensureRentalAvailability(quoted, {});
  await assert.rejects(
    () => ensureRentalAvailability({ ...quoted, lines: [...quoted.lines, ...quoted.lines] }, {}),
    { status: 409 },
  );
  assert.equal(reads.mock.callCount(), 2);
  assert.equal(RentalOrder.find.mock.callCount(), 2);
  assert.equal(Schedule.find.mock.callCount(), 2);
});

test('stock edits preserve combined rental and schedule holds, including schedule-only sizes', async (t) => {
  const { Types } = require('mongoose');
  mockHolds(t, [order('2090-02-01', '2090-02-03', 2)], [schedule('2090-02-02', '2090-02-03')]);
  await ensureRentalStockPreserved(new Types.ObjectId(id), stock.inventory, {});
  await assert.rejects(
    () =>
      ensureRentalStockPreserved(
        new Types.ObjectId(id),
        [{ size: 'M', condition: 'good', quantity: 2 }],
        {},
      ),
    { status: 409 },
  );
  RentalOrder.find.mock.restore();
  Schedule.find.mock.restore();
  mockHolds(t, [], [schedule('2090-02-02', '2090-02-03', 2, 'L')]);
  await assert.rejects(
    () => ensureRentalStockPreserved(new Types.ObjectId(id), stock.inventory, {}),
    { status: 409 },
  );
});
