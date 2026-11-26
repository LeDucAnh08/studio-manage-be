const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
process.env.JWT_SECRET = 'remove-seasons-test-only';
require('ts-node/register/transpile-only');

const mongoose = require('mongoose');
const User = require('../src/models/User').default;
const models = ['Class', 'Schedule', 'Transaction'].map(
  (name) => require(`../src/models/${name}`).default,
);
require('../src/config/db').default = () => new Promise(() => {});
const app = require('../src/app').default;

test('season schema fields are removed and old filters do not hide classes, schedules or transactions', async (t) => {
  const jwt = require('jsonwebtoken');
  const actor = new mongoose.Types.ObjectId();
  t.mock.method(User, 'findById', () => ({
    select: async () => ({ _id: actor, roles: [1], isActive: true }),
  }));
  const filters = new Map();
  for (const model of models) {
    assert.equal(model.schema.path('season'), undefined);
    assert.equal(Object.hasOwn(new model({ season: actor }).toObject(), 'season'), false);
    assert.ok(model.schema.indexes().every(([keys]) => !('season' in keys)));
    t.mock.method(model, 'find', (filter) => {
      filters.set(model.modelName, filter);
      const query = {
        populate: () => query,
        sort: () => query,
        skip: () => query,
        limit: () => query,
        lean: async () => [],
      };
      return query;
    });
    t.mock.method(model, 'countDocuments', async () => 0);
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = {
    Authorization: `Bearer ${jwt.sign({ id: String(actor) }, process.env.JWT_SECRET)}`,
  };
  for (const [route, model] of [
    ['customers', 'Class'],
    ['schedules', 'Schedule'],
    ['transactions', 'Transaction'],
  ]) {
    const response = await fetch(`${base}/${route}?season=obsolete&page=1&limit=20`, { headers });
    assert.equal(response.status, 200, route);
    assert.deepEqual(filters.get(model), {}, route);
  }
  for (const route of ['schedules', 'transactions']) {
    assert.equal(
      (
        await fetch(`${base}/${route}?dateFrom=2026-11-01&dateTo=2026-11-30&season=obsolete`, {
          headers,
        })
      ).status,
      200,
    );
    const filter = filters.get(route === 'schedules' ? 'Schedule' : 'Transaction');
    assert.deepEqual(filter[route === 'schedules' ? 'shootDate' : 'date'], {
      $gte: new Date('2026-11-01'),
      $lte: new Date('2026-11-30'),
    });
    assert.equal(Object.hasOwn(filter, 'season'), false);
  }
  for (const [method, suffix] of [
    ['GET', ''],
    ['POST', ''],
    ['PUT', '/old'],
    ['DELETE', '/old'],
  ])
    assert.equal((await fetch(`${base}/seasons${suffix}`, { method, headers })).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('cleanup matches the backed-up season value, including null, before removing it', () => {
  const { seasonSnapshotFilter } = require('../src/utils/removeSeasons');
  const id = new mongoose.Types.ObjectId();
  assert.deepEqual(seasonSnapshotFilter({ _id: id, season: null }), {
    _id: id,
    season: { $exists: true, $eq: null },
  });
  const season = new mongoose.Types.ObjectId();
  assert.deepEqual(seasonSnapshotFilter({ _id: id, season }), {
    _id: id,
    season: { $exists: true, $eq: season },
  });
});

test('Drive and Sheet create without seasons and preserve old rows and folder links', () => {
  const sheets = [];
  const folders = new Map();
  const createdParents = [];
  const makeFolder = (id) => ({
    getId: () => id,
    getUrl: () => `https://drive.google.com/drive/folders/${id}`,
    setTrashed(value) {
      this.trashed = value;
    },
    getFoldersByName: () => ({ hasNext: () => false }),
    createFolder: (name) => {
      createdParents.push(id);
      const folder = makeFolder(`new-${folders.size}`);
      folders.set(folder.getId(), folder);
      return folder;
    },
  });
  folders.set('root', makeFolder('root'));
  folders.set('original-folder', makeFolder('original-folder'));
  const makeSheet = (name) => {
    const rows = [];
    return {
      name,
      rows,
      getLastRow: () => rows.length,
      appendRow: (row) => rows.push([...row]),
      deleteRow: (row) => rows.splice(row - 1, 1),
      getRange(row, col, count = 1, width = 1) {
        return {
          getValue: () => rows[row - 1]?.[col - 1],
          getValues: () =>
            rows
              .slice(row - 1, row - 1 + count)
              .map((values) => values.slice(col - 1, col - 1 + width)),
          setValues: (values) => {
            values.forEach((value, index) => {
              rows[row - 1 + index] = [...value];
            });
          },
        };
      },
    };
  };
  const workbook = {
    getSheets: () => sheets,
    getSheetByName: (name) => sheets.find((sheet) => sheet.name === name),
    insertSheet: (name) => {
      const sheet = makeSheet(name);
      sheets.push(sheet);
      return sheet;
    },
  };
  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => ({ SECRET: 'test', ROOT_FOLDER_ID: 'root', SHEET_ID: 'sheet' })[key],
      }),
    },
    DriveApp: {
      getFolderById: (id) => {
        assert.ok(folders.has(id));
        return folders.get(id);
      },
    },
    SpreadsheetApp: { openById: () => workbook },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (value) => ({ setMimeType: () => JSON.parse(value) }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../google-apps-script/Code.gs'), 'utf8'),
    sandbox,
  );
  const call = (body) =>
    sandbox.doPost({ postData: { contents: JSON.stringify({ secret: 'test', ...body }) } });
  const legacy = workbook.insertSheet('Old grouping');
  legacy.appendRow(sandbox.HEADERS);
  legacy.appendRow([
    'original-date',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    folders.get('original-folder').getUrl(),
    '',
    '',
    'old-schedule',
  ]);
  const result = call({ scheduleId: 'new-schedule', className: '12A1', shootDate: '26/11/2026' });
  assert.equal(result.ok, true);
  assert.deepEqual(createdParents, ['root']);
  assert.equal(workbook.getSheetByName('Lịch chụp').rows.length, 2);
  assert.equal(
    call({ scheduleId: 'old-schedule', className: 'Updated' }).folderId,
    'original-folder',
  );
  assert.equal(legacy.rows.length, 2);
  assert.equal(legacy.rows[1][0], 'original-date');
  assert.equal(legacy.rows[1][2], 'Updated');
  assert.deepEqual(createdParents, ['root']);
  const removed = call({
    action: 'delete',
    scheduleId: 'old-schedule',
    folderId: 'original-folder',
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.deletedRow, true);
  assert.equal(folders.get('original-folder').trashed, true);
  assert.equal(legacy.rows.length, 1);
  assert.equal(workbook.getSheetByName('Lịch chụp').rows.length, 2);
});
