import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import { WorkflowProblem } from './workflowTransactions';

export type PaymentMode = 'sandbox' | 'live';
export interface DepositPaymentSnapshot {
  provider: 'sepay';
  mode: PaymentMode;
  reference: string;
  bankCode: string;
  bankGateway: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  amount: number;
  expiresAt: Date;
  createdAt: Date;
}

export const sepayEnabled = () => process.env.SEPAY_ENABLED === 'true';
export const sandboxUiEnabled = () =>
  process.env.SEPAY_DEMO_UI === 'true' &&
  process.env.NODE_ENV === 'development' &&
  sepayEnabled() &&
  process.env.SEPAY_MODE === 'sandbox' &&
  !!process.env.SEPAY_SANDBOX_DATABASE?.startsWith('studio_sepay_') &&
  mongoose.connection.name === process.env.SEPAY_SANDBOX_DATABASE &&
  ['localhost', '127.0.0.1', '::1', '[::1]'].includes(mongoose.connection.host || '');
export const normalizeBankGateway = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function sepayConfig() {
  const mode = process.env.SEPAY_MODE;
  const config = {
    mode: mode as PaymentMode,
    secret: process.env.SEPAY_WEBHOOK_SECRET?.trim() ?? '',
    bankCode: process.env.PAYMENT_BANK_CODE?.trim() ?? '',
    bankGateway:
      process.env.SEPAY_BANK_GATEWAY?.trim() || process.env.PAYMENT_BANK_CODE?.trim() || '',
    bankName: process.env.PAYMENT_BANK_NAME?.trim() ?? '',
    accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER?.trim() ?? '',
    accountName: process.env.PAYMENT_ACCOUNT_NAME?.trim() ?? '',
  };
  if (
    !sepayEnabled() ||
    process.env.CLIENT_WORKFLOW_ENABLED?.toLowerCase() !== 'true' ||
    !['sandbox', 'live'].includes(mode ?? '') ||
    Object.entries(config).some(([, value]) => !value) ||
    config.secret.length < 32 ||
    !/^[A-Za-z0-9]{2,30}$/.test(config.bankCode) ||
    !/^[A-Za-z0-9]{5,40}$/.test(config.accountNumber)
  ) {
    throw new WorkflowProblem(503, 'Chưa cấu hình đầy đủ tài khoản ngân hàng và webhook SePay.');
  }
  if (
    mode === 'sandbox' &&
    (!process.env.SEPAY_SANDBOX_DATABASE?.startsWith('studio_sepay_') ||
      mongoose.connection.name !== process.env.SEPAY_SANDBOX_DATABASE)
  )
    throw new WorkflowProblem(503, 'SePay sandbox cần database riêng có tên studio_sepay_*.');
  if (mode === 'live' && mongoose.connection.name?.startsWith('studio_sepay_'))
    throw new WorkflowProblem(503, 'Không được nhận tiền thật trong database sandbox.');
  // These connections require VA-specific QR rules, beyond the plain-account v1.
  if (
    [
      'ocb',
      'kienlongbank',
      'msb',
      'bidv',
      'vietinbank',
      '970448',
      '970452',
      '970426',
      '970418',
      '970415',
    ].includes(config.bankCode.toLowerCase())
  )
    throw new WorkflowProblem(
      503,
      'Kết nối ngân hàng này cần cấu hình VA/nội dung đặc biệt. V1 hỗ trợ tài khoản thường, ví dụ MBBank.',
    );
  return config;
}

export function createDepositPayment(
  booking: any,
  workflow: any,
): DepositPaymentSnapshot | undefined {
  if (!sepayEnabled()) return undefined;
  const config = sepayConfig();
  if (!booking.packageAgreement || workflow.packageReservation?.status !== 'held')
    throw new WorkflowProblem(409, 'Đơn theo gói chưa được giữ lịch để thanh toán cọc.');
  return {
    provider: 'sepay',
    mode: config.mode,
    reference: `YUME${randomBytes(8).toString('hex').toUpperCase()}`,
    bankCode: config.bankCode,
    bankGateway: normalizeBankGateway(config.bankGateway),
    bankName: config.bankName,
    accountNumber: config.accountNumber,
    accountName: config.accountName,
    amount: workflow.quote.depositRequired,
    expiresAt: workflow.packageReservation.expiresAt,
    createdAt: new Date(),
  };
}

export function depositPaymentDto(booking: any, workflow: any, now = new Date()) {
  const payment = workflow?.depositPayment;
  if (!payment || !booking.packageAgreement || booking.status !== 'approved') return null;
  const net = workflow.payments.reduce(
    (sum: number, item: any) => sum + (item.kind === 'refund' ? -item.amount : item.amount),
    0,
  );
  const amount = Math.max(0, (workflow.quote?.depositRequired ?? payment.amount) - net);
  const expiresAt = new Date(
    Math.min(
      +new Date(payment.expiresAt),
      +new Date(workflow.packageReservation?.expiresAt ?? payment.expiresAt),
    ),
  );
  let activeConfig = false;
  try {
    const config = sepayConfig();
    activeConfig =
      payment.mode === config.mode &&
      payment.accountNumber === config.accountNumber &&
      payment.bankGateway === normalizeBankGateway(config.bankGateway) &&
      payment.bankCode === config.bankCode;
  } catch {
    /* Do not advertise an obsolete QR after config rotation/disablement. */
  }
  const status =
    workflow.resources?.schedule && amount === 0 && workflow.lifecycle !== 'cancelled'
      ? 'paid'
      : !activeConfig
        ? 'unavailable'
        : workflow.packageReservation?.status === 'held' &&
            workflow.lifecycle === 'awaiting_deposit' &&
            expiresAt > now &&
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
    depositRequired: workflow.quote?.depositRequired ?? payment.amount,
    expiresAt,
    status,
    qrUrl: status === 'pending' ? qrUrl : null,
    downloadUrl: status === 'pending' ? `${qrUrl}&download=true` : null,
  };
}
