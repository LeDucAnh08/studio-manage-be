import { createHash } from 'crypto';
import { isValidObjectId } from 'mongoose';
import { WorkflowProblem } from './workflowTransactions';

export const conceptEnabled = () => process.env.CONCEPT_BOOKING_ENABLED === 'true';
export const HOUR = 3600000;
export const HOLD_MS = 15 * 60000;
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function text(value: unknown, max: number, required = true): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new WorkflowProblem(400, 'Nội dung không hợp lệ.');
  return value.trim();
}
export function integer(value: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new WorkflowProblem(400, `Nhập số nguyên từ ${min} đến ${max}.`);
  return Number(value);
}
export function objectId(value: unknown): string {
  if (typeof value !== 'string' || !isValidObjectId(value))
    throw new WorkflowProblem(400, 'Mã không hợp lệ.');
  return value;
}
export function safeUrl(value: unknown) {
  const raw = text(value, 1000);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new WorkflowProblem(400, 'Dùng đường dẫn HTTPS hợp lệ.');
  }
}
export function conceptImageUrl(value: unknown) {
  if (typeof value === 'string' && /^\/images\/concepts\/[a-z0-9][a-z0-9-]*\.webp$/.test(value))
    return value;
  return safeUrl(value);
}
export function commandKey(value: unknown) {
  if (typeof value !== 'string' || !/^[\w.:-]{8,128}$/.test(value))
    throw new WorkflowProblem(400, 'Thiếu Idempotency-Key hợp lệ.');
  return value;
}
export function beginCommand(
  doc: any,
  key: string,
  payload: unknown,
  expectedVersion: unknown,
): boolean {
  const fingerprint = digest(payload);
  const prior = doc.commands.find((row: any) => row.key === key);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new WorkflowProblem(409, 'Khóa đã dùng với nội dung khác.');
    return false;
  }
  if (doc.version !== expectedVersion)
    throw new WorkflowProblem(409, 'Dữ liệu đã thay đổi. Tải lại rồi thử lại.');
  doc.commands.push({ key, fingerprint });
  if (doc.commands.length > 2000) doc.commands.splice(0, doc.commands.length - 2000);
  doc.version += 1;
  return true;
}
export function cancellationAmounts(order: any, now = Date.now()) {
  const cutoff = Math.min(+new Date(order.originalStartAt), +new Date(order.startAt));
  const remaining = cutoff - now;
  if (now >= +new Date(order.startAt) || !['confirmed', 'awaiting_deposit'].includes(order.status))
    throw new WorkflowProblem(409, 'Đơn không còn được tự hủy. Liên hệ Studio.');
  const received = order.payments.reduce(
    (sum: number, p: any) => sum + (p.kind === 'refund' ? -p.amount : p.amount),
    0,
  );
  const retained =
    order.status === 'awaiting_deposit'
      ? 0
      : remaining >= 48 * HOUR
        ? 0
        : remaining >= 24 * HOUR
          ? Math.ceil(order.snapshot.deposit / 2)
          : order.snapshot.deposit;
  return { retained: Math.min(retained, received), refundDue: Math.max(0, received - retained) };
}
export function canReschedule(order: any, now = Date.now()) {
  return (
    order.status === 'confirmed' &&
    order.rescheduleCount === 0 &&
    +new Date(order.startAt) - now >= 48 * HOUR
  );
}
