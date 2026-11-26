// Configuration only: no database, Redis connection or external providers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');
const { queueConfig } = require('../src/config/queue');

test('queue namespace supports MongoDB seed lists and preserves existing single-host scopes', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      BACKGROUND_JOBS_MODE: 'bullmq',
      BACKGROUND_JOBS_PREFIX: 'yume',
      REDIS_URL: 'redis://:test-password@127.0.0.1:6385/0',
      NODE_ENV: 'development',
      EMAIL_MODE: 'resend',
    });
    for (const hosts of [
      '127.0.0.1:27017',
      '[::1]:27017',
      'cluster.example.mongodb.net',
      'node1.example.mongodb.net:27017,node2.example.mongodb.net:27017,node3.example.mongodb.net:27017',
    ]) {
      const scheme = hosts === 'cluster.example.mongodb.net' ? 'mongodb+srv' : 'mongodb';
      process.env.MONGO_URI = `${scheme}://user:p%40ss@${hosts}/studio_db?retryWrites=true`;
      const expected = createHash('sha256')
        .update(`${hosts}/studio_db/development/resend`)
        .digest('hex')
        .slice(0, 16);
      const config = queueConfig();
      assert.equal(config.mode, 'bullmq');
      assert.equal(config.prefix, `yume-${expected}`);
      assert.equal(config.url, process.env.REDIS_URL);

      process.env.MONGO_URI = `${scheme}://other:secret@${hosts}/studio_db?retryWrites=false`;
      assert.equal(queueConfig().prefix, config.prefix);
      process.env.MONGO_URI = `${scheme}://${hosts}/other_db`;
      assert.notEqual(queueConfig().prefix, config.prefix);
    }

    for (const uri of ['', 'not-a-uri', 'https://example.test/studio_db', 'mongodb://']) {
      process.env.MONGO_URI = uri;
      assert.throws(queueConfig, /Background jobs require valid MongoDB and Redis configuration/);
    }
    process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/studio_db';
    for (const uri of ['', 'invalid', 'http://127.0.0.1:6385', 'redis://127.0.0.1:6385/0?x=1']) {
      process.env.REDIS_URL = uri;
      assert.throws(queueConfig);
    }
    process.env.REDIS_URL = 'redis://remote.example:6385/0';
    assert.throws(queueConfig, /Development Redis must use loopback/);
    process.env.BACKGROUND_JOBS_MODE = 'legacy';
    process.env.MONGO_URI = '';
    assert.deepEqual(queueConfig(), { mode: 'legacy' });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
