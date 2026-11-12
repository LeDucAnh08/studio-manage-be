import { randomBytes } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import RentalOrder from '../models/RentalOrder';
import Category from '../models/Category';
import Transaction from '../models/Transaction';
import {
  sepayConfig,
  sepayEnabled,
  normalizeBankGateway,
  sandboxUiEnabled,
} from './depositPayment';
import { withResourceTransaction, WorkflowProblem } from './workflowTransactions';
import { ensureRentalAvailability } from './rentalAvailability';
import { rentalPolicy, validateRentalServiceDates } from './rentalPolicy';
import { rentalDays } from '../utils/rentalPeriod';

export const rentalNet = (order: any): number =>
  order.payments.reduce(
    (sum: number, item: any) => sum + (item.kind === 'refund' ? -item.amount : item.amount),
    0,
  );
export const rentalPaid = (order: any): boolean =>
  !!order.paymentLockedAt ||
  order.payments.some((item: any) => item.kind !== 'refund' && item.amount > 0);

// Old quotes keep their refundable security deposit; new advances are part of the rental fee.
export const rentalChargeTotal = (quote: { fee: number; deposit: number; depositKind?: string }) =>
  quote.fee + (quote.depositKind === 'advance' ? 0 : quote.deposit);

export function automaticRentalQuote(
  lines: any[],
  period: { receiveDate: Date; returnDate: Date },
) {
  const policy = validateRentalServiceDates(period);
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitPrice) || line.unitPrice <= 0)
      throw new WorkflowProblem(409, 'Mẫu chưa cấu hình giá thuê/ngày. Vui lòng liên hệ studio.');
  }
  const days = rentalDays(period.receiveDate, period.returnDate);
  const fee = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity * days, 0);
  const deposit = Math.ceil((fee * policy.depositPercent) / 100);
  if (
    ![fee, deposit].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000_000,
    )
  )
    throw new WorkflowProblem(400, 'Tổng tiền thuê/cọc vượt giới hạn.');
  return {
    version: 1,
    pricingMode: 'daily',
    rentalDays: days,
    turnaroundDays: policy.turnaroundDays,
    lines,
    ...period,
    fee,
    deposit,
    depositKind: 'advance',
    depositPercent: policy.depositPercent,
    terms: policy.terms,
    proposedAt: new Date(),
    acceptedAt: new Date(),
  };
}

export function rentalPaymentSnapshot(amount: number, expiresAt: Date) {
  if (!amount || !sepayEnabled()) return undefined;
  const config = sepayConfig();
  return {
    provider: 'sepay',
    mode: config.mode,
    reference: `RENT${randomBytes(8).toString('hex').toUpperCase()}`,
    bankCode: config.bankCode,
    bankGateway: normalizeBankGateway(config.bankGateway),
    bankName: config.bankName,
    accountNumber: config.accountNumber,
    accountName: config.accountName,
    amount,
    expiresAt,
    createdAt: new Date(),
  };
}

export function rentalPaymentDto(order: any) {
  const payment = order.depositPayment;
  if (!payment || !order.autoCheckout) return null;
  let valid = false;
  try {
    const config = sepayConfig();
    valid =
      payment.mode === config.mode &&
      payment.accountNumber === config.accountNumber &&
      payment.bankGateway === normalizeBankGateway(config.bankGateway) &&
      payment.bankCode === config.bankCode;
  } catch {
    /* Hide old QR when bank configuration is disabled or rotated. */
  }
  const amount = Math.max(0, order.quote.deposit - rentalNet(order));
  const status =
    order.status === 'confirmed' || order.checkedOutAt
      ? 'paid'
      : !valid
        ? 'unavailable'
        : order.status === 'awaiting_deposit' &&
            order.reservation?.status === 'held' &&
            +new Date(order.reservation.expiresAt) > Date.now() &&
            amount > 0
          ? 'pending'
          : 'expired';
  const params = new URLSearchParams({
    acc: payment.accountNumber,
    bank: payment.bankCode,
    amount: String(amount),
    des: payment.reference,
    template: 'qronly',
    holder: payment.accountName,
  });
  const qrUrl = `https://vietqr.app/img?${params}`;
  return {
    provider: 'sepay' as const,
    ...(sandboxUiEnabled() ? { demoSimulation: true } : {}),
    mode: payment.mode,
    reference: payment.reference,
    bankName: payment.bankName,
    accountName: payment.accountName,
    accountNumber: payment.accountNumber,
    amount,
    depositRequired: order.quote.deposit,
    expiresAt: order.reservation.expiresAt,
    status,
    qrUrl: status === 'pending' ? qrUrl : null,
    downloadUrl: status === 'pending' ? `${qrUrl}&download=true` : null,
  };
}

export async function recordRentalMoney(
  order: any,
  data: {
    kind: string;
    amount: number;
    method: string;
    reference?: string;
    actor?: unknown;
    providerReceipt?: unknown;
    at?: Date;
  },
  session: ClientSession,
) {
  if (
    data.kind !== 'refund' &&
    data.method === 'bank_transfer' &&
    data.reference &&
    order.payments.some(
      (item: any) =>
        item.kind !== 'refund' &&
        item.method === 'bank_transfer' &&
        item.reference === data.reference,
    )
  )
    throw new WorkflowProblem(409, 'Giao dịch chuyển khoản này đã được ghi nhận.');
  const type = data.kind === 'refund' ? 'expense' : 'income';
  const name =
    data.kind === 'refund'
      ? 'Hoàn cọc thuê'
      : data.kind === 'deposit'
        ? 'Cọc thuê'
        : 'Thanh toán thuê';
  let category = await Category.findOne({ name, type }).session(session);
  if (!category)
    [category] = await Category.create([{ name, type, isDefault: true, createdBy: data.actor }], {
      session,
    });
  const paymentId = new Types.ObjectId();
  const [transaction] = await Transaction.create(
    [
      {
        rentalOrder: order._id,
        rentalPayment: paymentId,
        amount: data.amount,
        type,
        categoryId: category._id,
        date: data.at ?? new Date(),
        createdBy: data.actor,
        description: `Đơn thuê ${order._id}`,
      },
    ],
    { session },
  );
  order.payments.push({
    _id: paymentId,
    ...data,
    at: data.at ?? new Date(),
    transaction: transaction._id,
  });
  if (data.kind !== 'refund') order.paymentLockedAt = order.paymentLockedAt ?? new Date();
  return paymentId;
}

export async function confirmAutomaticRental(order: any, session: ClientSession, now = new Date()) {
  if (
    !order.autoCheckout ||
    rentalNet(order) < order.quote.deposit ||
    !['awaiting_deposit', 'ready_to_confirm', 'expired', 'payment_review'].includes(order.status)
  )
    return;
  try {
    if (order.reservation?.status !== 'held' || +order.reservation.expiresAt <= +now)
      validateRentalServiceDates(order.quote, now);
    await ensureRentalAvailability(order.quote, session, String(order._id));
    order.status = 'confirmed';
    order.reservation.status = 'confirmed';
    order.reservationIssue = undefined;
    order.events.push({
      action: 'resources.confirm',
      at: now,
      message: 'Đã nhận đủ cọc và tự động xác nhận giữ trang phục.',
    });
  } catch (error) {
    if (!(error instanceof WorkflowProblem) || error.status >= 500) throw error;
    order.status = 'payment_review';
    order.reservation.status = 'released';
    order.reservationIssue =
      'Đã nhận tiền nhưng không thể giữ đủ hàng: ' + error.message + ' Studio cần xử lý hoàn tiền.';
  }
}

export function expireRentalOrder(order: any, now = new Date()) {
  if (
    !order.autoCheckout ||
    order.status !== 'awaiting_deposit' ||
    order.reservation?.status !== 'held' ||
    +order.reservation.expiresAt > +now
  )
    return false;
  order.status = 'expired';
  order.reservation.status = 'expired';
  order.version += 1;
  order.events.push({
    action: 'reservation.expire',
    at: now,
    message: 'Hết hạn đặt cọc; đã trả giữ hàng. Tiền đã nhận sẽ được đối soát hoàn lại.',
  });
  return true;
}
export async function expireRentalReservations(now = new Date()) {
  const rows = await RentalOrder.find({
    autoCheckout: true,
    status: 'awaiting_deposit',
    'reservation.status': 'held',
    'reservation.expiresAt': { $lte: now },
  })
    .select('_id')
    .lean();
  for (const row of rows)
    await withResourceTransaction(async (session) => {
      const order = await RentalOrder.findById(row._id).session(session);
      if (order && expireRentalOrder(order, now)) await order.save({ session });
    });
  const overdue = await RentalOrder.find({
    autoCheckout: true,
    status: 'checked_out',
    'quote.returnDate': {
      $lt: new Date(Math.floor((+now + 7 * 3600000) / 86400000) * 86400000 - 7 * 3600000),
    },
  })
    .select('quote.lines')
    .lean();
  if (overdue.length)
    await withResourceTransaction(async (session) => {
      await auditRentalFulfillment(
        [
          ...new Set(
            overdue.flatMap((order: any) =>
              order.quote.lines.map((line: any) => String(line.costumeId)),
            ),
          ),
        ] as string[],
        session,
      );
    });
  return rows.length;
}

export async function auditRentalFulfillment(costumeIds: string[], session: ClientSession) {
  const orders = await RentalOrder.find({
    autoCheckout: true,
    status: 'confirmed',
    'quote.lines.costumeId': { $in: costumeIds },
  }).session(session);
  for (const order of orders) {
    let issue: string | undefined;
    try {
      await ensureRentalAvailability(order.quote, session, String(order._id));
    } catch (error) {
      if (!(error instanceof WorkflowProblem) || error.status >= 500) throw error;
      issue = 'Cần xử lý giao hàng: ' + error.message;
    }
    if (issue && issue !== order.reservationIssue) {
      order.reservationIssue = issue;
      order.version += 1;
      order.events.push({
        action: 'fulfillment.issue',
        at: new Date(),
        message: issue + ' Studio cần kiểm tra và hoàn tiền nếu không thể giao.',
      });
      await order.save({ session });
    } else if (!issue && order.reservationIssue?.startsWith('Cần xử lý giao hàng: ')) {
      order.reservationIssue = undefined;
      order.version += 1;
      await order.save({ session });
    }
  }
}

// Called inside the same resource transaction as receipt processing: money and reservation commit together.
export async function applyRentalReceipt(
  receipt: any,
  session: ClientSession,
  config: ReturnType<typeof sepayConfig>,
  overrideOrderId?: string,
) {
  const matches = [
    ...new Set<string>(receipt.content.toUpperCase().match(/\bRENT[A-F0-9]{16}\b/g) ?? []),
  ];
  const order: any = overrideOrderId
    ? await RentalOrder.findById(overrideOrderId).select('+depositPayment').session(session)
    : matches.length === 1
      ? await RentalOrder.findOne({ 'depositPayment.reference': matches[0] })
          .select('+depositPayment')
          .session(session)
      : null;
  if (!order && !overrideOrderId) return false;
  if (!order?.autoCheckout) throw new WorkflowProblem(409, 'Không tìm thấy đơn thuê tự động.');
  receipt.rentalOrder = order._id;
  const payment = order.depositPayment;
  let reason = '';
  if (
    receipt.direction !== 'in' ||
    receipt.hasConflict ||
    receipt.mode !== config.mode ||
    receipt.accountNumber !== config.accountNumber ||
    receipt.gateway !== normalizeBankGateway(config.bankGateway)
  )
    reason = 'Giao dịch ngân hàng không khớp hoặc đang có xung đột.';
  else if (
    !payment ||
    payment.mode !== receipt.mode ||
    payment.accountNumber !== receipt.accountNumber ||
    payment.bankGateway !== receipt.gateway ||
    payment.bankCode !== config.bankCode
  )
    reason = 'Không khớp cấu hình ngân hàng của đơn thuê.';
  else if (
    +receipt.transactionDate < +new Date(payment.createdAt) - 1000 ||
    +receipt.transactionDate > Date.now() + 300000
  )
    reason = 'Thời điểm giao dịch không khớp đơn thuê.';
  else {
    order.paymentLockedAt = order.paymentLockedAt ?? new Date();
    if (
      ![
        'awaiting_deposit',
        'expired',
        'payment_review',
        ...(overrideOrderId ? ['confirmed', 'cancelled'] : []),
      ].includes(order.status)
    )
      reason = 'Đơn không còn chờ cọc. Studio cần đối soát khoản tiền thêm.';
    else if (!overrideOrderId && receipt.amount > order.quote.deposit - rentalNet(order))
      reason = 'Số tiền vượt cọc còn thiếu. Studio cần đối soát khoản tiền thêm.';
    else {
      expireRentalOrder(order);
      const expired = ['expired', 'payment_review'].includes(order.status);
      if (
        !Number.isSafeInteger(rentalNet(order) + receipt.amount) ||
        rentalNet(order) + receipt.amount > 100_000_000_000
      )
        throw new WorkflowProblem(409, 'Tổng tiền ghi nhận vượt giới hạn.');
      receipt.rentalPayment = await recordRentalMoney(
        order,
        {
          kind: rentalNet(order) >= order.quote.deposit ? 'balance' : 'deposit',
          amount: receipt.amount,
          method: 'bank_transfer',
          reference: receipt.bankReference || receipt.providerTransactionId,
          providerReceipt: receipt._id,
          at: receipt.transactionDate,
        },
        session,
      );
      await confirmAutomaticRental(order, session);
      if (
        order.status === 'confirmed' &&
        !order.reservationIssue?.startsWith('Cần xử lý giao hàng: ')
      )
        order.reservationIssue = undefined;
      if (expired && order.status !== 'confirmed') {
        order.status = 'payment_review';
        order.reservationIssue =
          order.reservationIssue ||
          'Tiền về sau hạn, chưa đủ cọc để kiểm tra giữ lại hàng. Studio cần đối soát hoàn tiền.';
      }
      receipt.status = 'applied';
      order.events.push({
        action: 'payment.sepay',
        at: new Date(),
        message: `Đã ghi nhận ${receipt.amount.toLocaleString('vi-VN')} đ qua SePay.`,
      });
    }
  }
  if (reason) {
    receipt.status = 'review';
    receipt.reason = reason;
    order.reservationIssue = reason;
  }
  order.version += 1;
  await order.save({ session });
  await receipt.save({ session });
  return true;
}
