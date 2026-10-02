process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Costume = require('../src/models/Costume').default;
const costumeController = require('../src/controllers/costumeController');
const {
  readCostumeCatalogFilters,
  readCostumeInput,
} = require('../src/utils/costumeInput');

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
  assert.equal(readCostumeInput({ name: 'Áo dài', inventory: [{ size: 'XXS', quantity: 1 }] }).ok, false);
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

test('public catalog applies filters and returns sizes without stock counts or internal fields', async (t) => {
  let findFilter;
  Costume.find = (filter) => {
    findFilter = filter;
    const query = {
      select() { return this; },
      populate() { return this; },
      sort() { return this; },
      lean: async () => [
        {
          _id: '000000000000000000000001',
          name: 'Nón tốt nghiệp',
          description: 'Màu xanh',
          gender: 'unisex',
          itemKind: 'accessory',
          type: { _id: '000000000000000000000099', name: 'Đạo cụ', privateField: 'not public' },
          rentalPrice: 50000,
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
  };

  const app = express();
  app.get('/costumes', costumeController.getPublicCatalog);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/costumes?itemKind=accessory&categoryId=000000000000000000000099&size=FREE&minPrice=10000&maxPrice=80000`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(findFilter, {
    isRentalItem: true,
    itemKind: 'accessory',
    type: '000000000000000000000099',
    inventory: { $elemMatch: { size: 'FREE', quantity: { $gt: 0 }, condition: 'good' } },
    rentalPrice: { $gte: 10000, $lte: 80000 },
  });
  const payload = await response.json();
  assert.deepEqual(payload.data, [
    {
      _id: '000000000000000000000001',
      name: 'Nón tốt nghiệp',
      description: 'Màu xanh',
      gender: 'unisex',
      itemKind: 'accessory',
      categoryId: '000000000000000000000099',
      category: 'Đạo cụ',
      rentalPrice: 50000,
      sizes: ['FREE'],
    },
  ]);
});

test('legacy costumes opted into rental remain visible as clothing', async () => {
  let findFilter;
  Costume.find = (filter) => {
    findFilter = filter;
    return {
      select() { return this; },
      populate() { return this; },
      sort() { return this; },
      lean: async () => [{
        _id: '000000000000000000000002',
        name: 'Áo dài cũ',
        gender: 'female',
        type: null,
      }],
    };
  };

  let response;
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { response = body; return this; },
  };
  await costumeController.getPublicCatalog({ query: { itemKind: 'clothing' } }, res);

  assert.deepEqual(findFilter.itemKind, { $in: ['clothing', null] });
  assert.equal(res.statusCode, 200);
  assert.equal(response.data[0].itemKind, 'clothing');
  assert.equal(response.data[0].rentalPrice, 0);
});
