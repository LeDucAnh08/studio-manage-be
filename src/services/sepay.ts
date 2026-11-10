import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Types } from 'mongoose';
import Booking from '../models/Booking';
import BookingWorkflow from '../models/BookingWorkflow';
import SePayReceipt from '../models/SePayReceipt';
import { recordWorkflowPayment } from '../controllers/workflowController';
import { normalizeBankGateway, sepayConfig } from './depositPayment';
import { WorkflowProblem, withResourceTransaction } from './workflowTransactions';
import { applyRentalReceipt } from './rentalCheckout';
import { applyConceptReceipt } from './conceptPayments';
import ConceptOrder from '../models/ConceptOrder';

export function authenticateSePay(body: Buffer, signature: unknown, timestamp: unknown) {
  const config = sepayConfig();
  if (
    typeof signature !== 'string' ||
    !/^sha256=[a-f0-9]{64}$/.test(signature) ||
    typeof timestamp !== 'string' ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
  )
    throw new WorkflowProblem(401, 'Invalid SePay signature or timestamp');
  const expected = createHmac('sha256', config.secret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex')))
    throw new WorkflowProblem(401, 'Invalid SePay signature');
}

export function parseSePayPayload(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WorkflowProblem(400, 'Invalid SePay payload');
  const item = input as Record<string, unknown>;
  const text = (key: string, max: number, required = true): string => {
    const value = item[key];
    if (!required && (value === undefined || value === null || value === '')) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
      throw new WorkflowProblem(400, `Invalid SePay ${key}`);
    return value.trim();
  };
  if (
    !Number.isSafeInteger(item.id) ||
    Number(item.id) < 1 ||
    !Number.isSafeInteger(item.transferAmount) ||
    Number(item.transferAmount) < 1 ||
    Number(item.transferAmount) > 100_000_000_000 ||
    typeof item.transferType !== 'string' ||
    !['in', 'out'].includes(item.transferType)
  )
    throw new WorkflowProblem(400, 'Invalid SePay transaction or amount');
  const dateText = text('transactionDate', 19);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateText))
    throw new WorkflowProblem(400, 'Invalid bank timestamp');
  const date = new Date(`${dateText.replace(' ', 'T')}+07:00`);
  if (
    !Number.isFinite(+date) ||
    new Date(+date + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' ') !== dateText
  )
    throw new WorkflowProblem(400, 'Invalid bank calendar date');
  const content = text('content', 2000),
    code = text('code', 80, false);
  const gateway = normalizeBankGateway(text('gateway', 80));
  if (!gateway) throw new WorkflowProblem(400, 'Invalid SePay gateway');
  return {
    providerTransactionId: String(item.id),
    gateway,
    accountNumber: text('accountNumber', 80),
    content,
    code,
    amount: Number(item.transferAmount),
    direction: item.transferType as 'in' | 'out',
    transactionDate: date,
    bankReference: text('referenceCode', 120, false) || undefined,
  };
}

const referenceFrom = (content: string, code?: string) => {
  const matches = [
    ...new Set(content.toUpperCase().match(/\b(?:YUME|RENT|CONC)[A-F0-9]{16}\b/g) ?? []),
  ];
  if (matches.length !== 1 || (code && code.toUpperCase() !== matches[0])) return null;
  return matches[0];
};

export async function processSePayReceipt(receiptId: string | Types.ObjectId) {
  const config = sepayConfig();
  try {
    await withResourceTransaction(async (session) => {
      const receipt = await SePayReceipt.findById(receiptId).session(session);
      if (!receipt || receipt.status !== 'pending') return;
      let reason: string | undefined;
      const reference = referenceFrom(receipt.content);
      if (reference?.startsWith('CONC')) {
        await applyConceptReceipt(receipt, session, config);
        return;
      }
      if (reference?.startsWith('RENT') && (await applyRentalReceipt(receipt, session, config)))
        return;
      const workflow = reference
        ? await BookingWorkflow.findOne({ 'depositPayment.reference': reference }).session(session)
        : null;
      const booking = workflow ? await Booking.findById(workflow.booking).session(session) : null;
      if (booking) receipt.booking = booking._id;
      const payment = workflow?.depositPayment;
      const now = new Date();
      if (receipt.direction !== 'in') {
        receipt.status = 'ignored';
        reason = 'Giao dịch tiền ra';
      } else if (receipt.mode !== config.mode) reason = 'Sai môi trường thanh toán';
      else if (receipt.accountNumber !== config.accountNumber) reason = 'Sai tài khoản nhận';
      else if (receipt.gateway !== normalizeBankGateway(config.bankGateway))
        reason = 'Sai ngân hàng nhận';
      else if (!reference || !workflow || !booking || !payment)
        reason = 'Không tìm thấy mã thanh toán duy nhất của đơn';
      else if (
        payment.mode !== receipt.mode ||
        payment.bankCode !== config.bankCode ||
        payment.accountNumber !== receipt.accountNumber ||
        payment.bankGateway !== receipt.gateway
      )
        reason = 'Không khớp cấu hình thanh toán của đơn';
      else if (
        booking.status !== 'approved' ||
        !booking.packageAgreement ||
        workflow.lifecycle !== 'awaiting_deposit' ||
        workflow.packageReservation?.status !== 'held'
      )
        reason = 'Đơn đã hủy, đã thanh toán hoặc không còn chờ cọc';
      else if (
        Math.min(+new Date(payment.expiresAt), +new Date(workflow.packageReservation.expiresAt)) <=
          +now ||
        +receipt.transactionDate >=
          Math.min(+new Date(payment.expiresAt), +new Date(workflow.packageReservation.expiresAt))
      )
        reason = 'Tiền về sau hạn hoặc đơn đã hết thời hạn giữ lịch';
      else if (
        +receipt.transactionDate < +new Date(payment.createdAt) - 1000 ||
        +receipt.transactionDate > +now + 300000
      )
        reason = 'Thời điểm giao dịch không khớp yêu cầu thanh toán';
      else {
        const net = workflow.payments.reduce(
          (sum: number, row: any) => sum + (row.kind === 'refund' ? -row.amount : row.amount),
          0,
        );
        const remaining = workflow.quote!.depositRequired - net;
        if (receipt.amount > remaining) reason = 'Số tiền vượt quá tiền cọc còn thiếu';
        else {
          receipt.workflowPayment = await recordWorkflowPayment(
            booking,
            workflow,
            undefined,
            {
              kind: 'deposit',
              amount: receipt.amount,
              method: 'bank_transfer',
              reference: receipt.bankReference || receipt.providerTransactionId,
              receivedAt: receipt.transactionDate,
            },
            session,
            { source: 'sepay', providerReceipt: receipt._id },
          );
          workflow.version += 1;
          const message = workflow.resources.schedule
            ? 'Đã nhận đủ tiền cọc — lịch đã được xác nhận.'
            : `Đã nhận ${receipt.amount.toLocaleString('vi-VN')} đ tiền cọc qua SePay.`;
          workflow.events.push({ action: 'payment.sepay', audience: 'client', message, at: now });
          booking.events.push(
            { audience: 'client', message, at: now },
            { audience: 'admin', message, at: now },
          );
          await workflow.save({ session });
          await booking.save({ session });
          receipt.status = 'applied';
        }
      }
      if (reason) {
        receipt.status = receipt.status === 'ignored' ? 'ignored' : 'review';
        receipt.reason = reason;
      }
      await receipt.save({ session });
    });
  } catch (error) {
    if (!(error instanceof WorkflowProblem) || error.status >= 500) throw error;
    // Real money must remain visible if resource validation rejects confirmation.
    await withResourceTransaction(async (session) => {
      const receipt = await SePayReceipt.findOne({ _id: receiptId, status: 'pending' }).session(
        session,
      );
      if (!receipt) return;
      const reference = referenceFrom(receipt.content);
      if (reference?.startsWith('CONC')) {
        const order = await ConceptOrder.findOne({
          'paymentRequests.reference': reference,
        }).session(session);
        receipt.status = 'review';
        receipt.reason = error.message;
        if (order) receipt.conceptOrder = order._id;
        await receipt.save({ session });
        return;
      }
      const workflow = reference
        ? await BookingWorkflow.findOne({ 'depositPayment.reference': reference })
            .select('booking')
            .session(session)
        : null;
      await SePayReceipt.updateOne(
        { _id: receiptId, status: 'pending' },
        {
          $set: {
            status: 'review',
            reason: error.message,
            ...(workflow ? { booking: workflow.booking } : {}),
          },
        },
        { session },
      );
    });
  }
}

export async function ingestSePayPayload(input: unknown) {
  const config = sepayConfig(),
    data = parseSePayPayload(input);
  const payloadHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  let receiptId: Types.ObjectId | undefined;
  // Durable intake is separate from applying money so crashes and business-rule
  // failures never discard authenticated evidence of a bank transfer.
  await withResourceTransaction(async (session) => {
    const filter = {
      mode: config.mode,
      $or: [
        { providerTransactionId: data.providerTransactionId },
        ...(data.bankReference
          ? [
              {
                gateway: data.gateway,
                accountNumber: data.accountNumber,
                bankReference: data.bankReference,
              },
            ]
          : []),
      ],
    };
    const prior = await SePayReceipt.findOne(filter).session(session);
    if (prior) {
      if (
        prior.amount !== data.amount ||
        prior.content !== data.content ||
        prior.accountNumber !== data.accountNumber ||
        prior.gateway !== data.gateway ||
        (prior.code ?? '') !== data.code ||
        (prior.bankReference ?? '') !== (data.bankReference ?? '') ||
        +prior.transactionDate !== +data.transactionDate ||
        prior.direction !== data.direction
      ) {
        prior.hasConflict = true;
        prior.reason = 'Mã giao dịch ngân hàng trùng nhưng có dữ liệu khác; cần đối soát.';
        if (prior.status === 'pending') prior.status = 'review';
        if (!prior.conflicts.some((row) => row.payloadHash === payloadHash))
          prior.conflicts.push({ ...data, payloadHash });
        await prior.save({ session });
      }
      receiptId = prior._id;
      return;
    }
    const reference = referenceFrom(data.content, data.code);
    const [receipt] = await SePayReceipt.create(
      [
        {
          ...data,
          mode: config.mode,
          payloadHash,
          status: reference || data.direction === 'out' ? 'pending' : 'review',
          reason: reference
            ? undefined
            : 'Mã trong nội dung và mã SePay không khớp hoặc không hợp lệ',
        },
      ],
      { session },
    );
    receiptId = receipt._id;
  });
  await processSePayReceipt(receiptId!);
  return receiptId!;
}
