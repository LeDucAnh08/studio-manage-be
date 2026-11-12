// Configuration only: no real database connection or outbound email.
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
process.env.TS_NODE_PROJECT = path.join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const connectDB = require('../src/config/db').default;
const { emailConfig } = require('../src/services/email');
const { sepayConfig, sandboxUiEnabled } = require('../src/services/depositPayment');
const { simulateSandboxDeposit } = require('../src/services/sepaySandbox');

test('provider Test mode on studio_db needs explicit local development opt-in and cannot simulate payments', async () => {
  const saved = { ...process.env }, originalName = mongoose.connection.name, originalHost = mongoose.connection.host;
  try {
    Object.assign(process.env, {
      SEPAY_ENABLED: 'true', SEPAY_MODE: 'sandbox', CLIENT_WORKFLOW_ENABLED: 'true',
      SEPAY_TEST_ON_MAIN_DB: 'false', SEPAY_DEMO_UI: 'true', NODE_ENV: 'development',
      SEPAY_WEBHOOK_SECRET: 'provider-main-test-secret-at-least-32-characters',
      PAYMENT_BANK_CODE: 'MBBank', SEPAY_BANK_GATEWAY: 'MBBank', PAYMENT_BANK_NAME: 'QA Bank',
      PAYMENT_ACCOUNT_NAME: 'QA Test', PAYMENT_ACCOUNT_NUMBER: 'SBTEST001',
      SEPAY_SANDBOX_DATABASE: 'studio_sepay_sandbox',
    });
    mongoose.connection.name = 'studio_db'; mongoose.connection.host = '127.0.0.1';
    assert.throws(() => sepayConfig(), /database riêng/);
    process.env.SEPAY_TEST_ON_MAIN_DB = 'true';
    assert.equal(sepayConfig().mode, 'sandbox');
    assert.equal(mongoose.connection.name, 'studio_db');
    assert.equal(sandboxUiEnabled(), false);
    await assert.rejects(simulateSandboxDeposit({ _id: new mongoose.Types.ObjectId(), roles: [6] }, 'RENT0123456789ABCDEF', 'main-provider-test'), (error) => error.status === 404);
    for (const environment of ['production', 'test', '']) {
      process.env.NODE_ENV = environment;
      assert.throws(() => sepayConfig(), /database riêng/);
    }
    process.env.NODE_ENV = 'development';
    mongoose.connection.host = 'remote.example';
    assert.throws(() => sepayConfig(), /database riêng/);
    mongoose.connection.host = '127.0.0.1'; mongoose.connection.name = 'another_db';
    assert.throws(() => sepayConfig(), /database riêng/);
  } finally {
    mongoose.connection.name = originalName; mongoose.connection.host = originalHost;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('startup honors its explicit database URI and keeps sandbox email isolated', async () => {
  const saved = { ...process.env },
    originalConnect = mongoose.connect;
  const originalName = mongoose.connection.name,
    originalHost = mongoose.connection.host;
  try {
    Object.assign(process.env, {
      NODE_ENV: 'development',
      SEPAY_ENABLED: 'true',
      SEPAY_MODE: 'sandbox',
      SEPAY_SANDBOX_DATABASE: 'studio_sepay_sandbox',
      MONGO_URI: 'mongodb://127.0.0.1:27020/studio_db',
      EMAIL_ENABLED: 'true',
      EMAIL_MODE: 'test',
      EMAIL_FROM: 'Yume <notifications@example.test>',
      EMAIL_PUBLIC_URL: 'http://localhost:4001',
      JWT_SECRET: 'sandbox-startup-test-secret',
    });
    let captured;
    mongoose.connect = async (uri, options) => {
      captured = { uri, options };
      mongoose.connection.name = new URL(uri).pathname.slice(1);
      mongoose.connection.host = '127.0.0.1';
    };
    await connectDB();
    assert.equal(captured.uri, process.env.MONGO_URI);
    assert.equal(captured.options, undefined);
    assert.equal(mongoose.connection.name, 'studio_db');
    assert.throws(() => emailConfig(), /isolated/);
    process.env.SEPAY_ENABLED = 'false';
    await connectDB();
    assert.equal(captured.options, undefined);
    process.env.MONGO_URI = 'mongodb://127.0.0.1:27020/studio_sepay_sandbox';
    process.env.SEPAY_ENABLED = 'true';
    await connectDB();
    assert.equal(mongoose.connection.name, 'studio_sepay_sandbox');
    assert.equal(emailConfig().mode, 'test');
    process.env.EMAIL_MODE = 'resend';
    assert.throws(() => emailConfig(), /Sandbox cannot send real email/);
    process.env.NODE_ENV = 'production';
    process.env.SEPAY_ENABLED = 'true';
    await connectDB();
    assert.equal(captured.options, undefined);
  } finally {
    mongoose.connect = originalConnect;
    mongoose.connection.name = originalName;
    mongoose.connection.host = originalHost;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
