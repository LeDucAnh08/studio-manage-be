// Configuration checks only: no database connection or external email.
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');
const { emailConfig } = require('../src/services/email');

test('local Resend demo permits HTTP loopback only in development', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      EMAIL_ENABLED: 'true',
      EMAIL_MODE: 'resend',
      EMAIL_FROM: 'Yume Demo <onboarding@resend.dev>',
      RESEND_API_KEY: 'config-check-placeholder',
      JWT_SECRET: 'email-config-check-only-secret',
      SEPAY_ENABLED: 'false',
      NODE_ENV: 'development',
    });
    for (const origin of ['http://localhost:4001', 'http://127.0.0.1:4001', 'http://[::1]:4001']) {
      process.env.EMAIL_PUBLIC_URL = origin;
      assert.equal(emailConfig().origin, origin);
    }
    for (const origin of [
      'http://studio.example',
      'http://localhost.example:4001',
      'http://localhost:4001/account',
      'http://localhost:4001?redirect=other',
      'http://localhost:4001#token=example',
      'http://user:password@localhost:4001',
      'ftp://localhost:4001',
    ]) {
      process.env.EMAIL_PUBLIC_URL = origin;
      assert.throws(() => emailConfig(), /HTTPS/);
    }
    for (const environment of ['production', 'test', '']) {
      process.env.NODE_ENV = environment;
      process.env.EMAIL_PUBLIC_URL = 'http://localhost:4001';
      assert.throws(() => emailConfig(), /HTTPS/);
      process.env.EMAIL_PUBLIC_URL = 'https://studio.example';
      assert.equal(emailConfig().origin, 'https://studio.example');
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
