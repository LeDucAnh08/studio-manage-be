import { PipelineStage } from 'mongoose';
import { WorkflowProblem } from './workflowTransactions';

export const DAY = 86400000;
export const vnDate = (value: Date) =>
  new Date(value.getTime() + 25200000).toISOString().slice(0, 10);
export function reportRange(from: unknown, to: unknown, now = new Date()) {
  const today = vnDate(now);
  const read = (value: unknown, fallback: string) => {
    const text = value === undefined ? fallback : value;
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text))
      throw new WorkflowProblem(400, 'Ngày phải theo định dạng YYYY-MM-DD.');
    const date = new Date(`${text}T00:00:00+07:00`);
    if (!Number.isFinite(date.getTime()) || vnDate(date) !== text)
      throw new WorkflowProblem(400, 'Ngày không hợp lệ.');
    return date;
  };
  const start = read(from, today.slice(0, 8) + '01');
  const end = read(to, today);
  const days = (end.getTime() - start.getTime()) / DAY + 1;
  if (days < 1 || days > 366)
    throw new WorkflowProblem(400, 'Khoảng báo cáo phải từ 1 đến 366 ngày.');
  return { from: vnDate(start), to: vnDate(end), start, end, until: new Date(+end + DAY), days };
}
export function reportPage(value: unknown) {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^[1-9]\d{0,5}$/.test(value))
    throw new WorkflowProblem(400, 'Trang không hợp lệ.');
  return Number(value);
}
const net = {
  $sum: {
    $map: {
      input: { $ifNull: ['$payments', []] },
      as: 'p',
      in: {
        $cond: [{ $eq: ['$$p.kind', 'refund'] }, { $multiply: ['$$p.amount', -1] }, '$$p.amount'],
      },
    },
  },
};
const quotedTotal = {
  $sum: {
    $map: { input: '$quote.lines', as: 'l', in: { $multiply: ['$$l.quantity', '$$l.unitPrice'] } },
  },
};
// Normalize only fields required by the report; no contacts, roster or command keys.
export function financialProjection(service: 'photography' | 'rental'): PipelineStage[] {
  const photo = service === 'photography';
  const cancelled = { $eq: [photo ? '$lifecycle' : '$status', 'cancelled'] };
  const applied = { $eq: [photo ? '$changeRequest.status' : '$change.status', 'applied'] };
  const fee = photo
    ? {
        $cond: [
          { $and: [applied, { $ne: [{ $ifNull: ['$changeRequest.finalPayable', null] }, null] }] },
          '$changeRequest.finalPayable',
          quotedTotal,
        ],
      }
    : {
        $cond: [
          cancelled,
          '$change.finalFee',
          { $cond: ['$settlement.acceptedAt', '$settlement.total', '$quote.fee'] },
        ],
      };
  return [
    { $match: { 'quote.acceptedAt': { $type: 'date' } } },
    {
      $project: {
        service: { $literal: service },
        referenceId: photo ? '$booking' : '$_id',
        status: photo ? '$lifecycle' : '$status',
        fee,
        netReceived: net,
        target: photo
          ? fee
          : {
              $cond: [
                cancelled,
                '$change.finalFee',
                { $cond: ['$returnedAt', fee, { $add: ['$quote.fee', '$quote.deposit'] }] },
              ],
            },
        canRefund: photo
          ? applied
          : { $or: [cancelled, { $ne: [{ $ifNull: ['$settlement.acceptedAt', null] }, null] }] },
        security: photo
          ? { $literal: 0 }
          : {
              $cond: [
                { $or: [cancelled, { $ne: [{ $ifNull: ['$returnedAt', null] }, null] }] },
                0,
                '$quote.deposit',
              ],
            },
        pendingSettlement: photo
          ? { $literal: false }
          : {
              $and: [
                { $ne: [{ $ifNull: ['$returnedAt', null] }, null] },
                { $eq: [{ $ifNull: ['$settlement.acceptedAt', null] }, null] },
              ],
            },
        valueAt: {
          $cond: [
            cancelled,
            photo ? '$changeRequest.acceptedAt' : '$change.acceptedAt',
            photo ? '$progress.acceptedAt' : '$settlement.acceptedAt',
          ],
        },
        valueKind: { $cond: [cancelled, 'cancellation', 'service'] },
      },
    },
    {
      $set: {
        due: { $max: [0, { $subtract: ['$target', '$netReceived'] }] },
        refundDue: {
          $cond: ['$canRefund', { $max: [0, { $subtract: ['$netReceived', '$target'] }] }, 0],
        },
        depositHeld: { $min: ['$security', { $max: [0, '$netReceived'] }] },
        unsettledSurplus: {
          $cond: ['$pendingSettlement', { $max: [0, { $subtract: ['$netReceived', '$fee'] }] }, 0],
        },
      },
    },
    { $project: { security: 0, canRefund: 0, pendingSettlement: 0 } },
  ];
}
