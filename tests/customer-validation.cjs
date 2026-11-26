process.env.TS_NODE_PROJECT = require('path').join(__dirname, '../tsconfig.json');
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { publicStudentError, publicFeedbackError } = require('../src/utils/publicFormValidation');
const Class = require('../src/models/Class').default;
const Student = require('../src/models/Student').default;
const Feedback = require('../src/models/Feedback').default;
const Schedule = require('../src/models/Schedule').default;
const User = require('../src/models/User').default;
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'isolated-validation-secret';
const customerId = '000000000000000000000001';
const student = {
  customer: customerId,
  access: 'isolated-access',
  name: 'Nguyễn An',
  gender: 'female',
  height: 165.5,
  weight: 55.5,
  notes: '',
  costumes: [],
};
const feedback = {
  crewFeedback: { rating: 4, description: 'Ekip tốt' },
  albumFeedback: { rating: 5, description: 'Ảnh đẹp' },
  phone: '',
  content: '',
  suggestion: '',
};

test('public form boundaries reject malformed types, ranges, whitespace and oversized text', () => {
  assert.equal(publicStudentError(student), undefined);
  for (const patch of [
    { name: ' ' },
    { name: 'x'.repeat(101) },
    { height: 251 },
    { height: NaN },
    { weight: 9 },
    { weight: Infinity },
    { height: '165' },
    { gender: 'invalid' },
    { notes: {} },
    { notes: 'x'.repeat(2001) },
    { costumes: ['invalid'] },
  ])
    assert.ok(publicStudentError({ ...student, ...patch }), JSON.stringify(patch));
  assert.equal(publicFeedbackError(feedback), undefined);
  for (const patch of [
    { crewFeedback: { rating: 1.5, description: 'OK' } },
    { albumFeedback: { rating: 5, description: ' ' } },
    { phone: 'letters' },
    { content: {} },
    { content: 'x'.repeat(4001) },
    { suggestion: 'x'.repeat(4001) },
    { crewFeedback: { rating: 3, description: 'x'.repeat(2001) } },
  ])
    assert.ok(publicFeedbackError({ ...feedback, ...patch }), JSON.stringify(patch));
  assert.equal(publicFeedbackError({ ...feedback, phone: '+84 901 234 567' }), undefined);
});

test('public HTTP forms return useful 400 messages and never write rejected input', async (t) => {
  let writes = 0;
  User.findById = () => ({ select: async () => ({ _id: customerId, roles: [6], isActive: true }) });
  const authorization = `Bearer ${jwt.sign({ id: customerId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  Class.findOne = () => ({ select: async () => ({ publicAccessToken: 'isolated-access' }) });
  Schedule.findOne = () => ({ select: () => ({ lean: async () => ({ costumes: [] }) }) });
  Student.create = async (body) => {
    writes++;
    return { _id: 'student', ...body };
  };
  Feedback.create = async (body) => {
    writes++;
    return { _id: 'feedback', ...body };
  };
  const app = express();
  app.use(express.json());
  app.use('/public', require('../src/routes/public').default);
  app.use((error, req, res, next) => res.status(500).json({ message: 'Unexpected test error' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/public`;
  const post = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  for (const [path, body, pattern] of [
    ['/students', { ...student, height: 300 }, /Chiều cao/],
    ['/students', { ...student, name: ' ' }, /Họ tên/],
    ['/feedback', { ...feedback, phone: '123' }, /Số điện thoại/],
    ['/feedback', { ...feedback, albumFeedback: { rating: 0, description: '' } }, /1 đến 5 sao/],
  ]) {
    const result = await post(path, body);
    assert.equal(result.status, 400);
    assert.match(result.body.message, pattern);
  }
  assert.equal(writes, 0);
  const unassigned = await post('/students', {
    ...student,
    costumes: ['000000000000000000000099'],
  });
  assert.equal(unassigned.status, 400);
  assert.match(unassigned.body.message, /trang phục trong gói/);
  assert.equal(writes, 0);
  assert.equal((await post('/students', student)).status, 201);
  assert.equal((await post('/feedback', feedback)).status, 201);
  assert.equal(writes, 2);
  const invalidLink = await post('/students', { ...student, customer: 'bad' });
  assert.equal(invalidLink.status, 400);
  assert.match(invalidLink.body.message, /liên kết/);
  assert.equal(writes, 2);
});
