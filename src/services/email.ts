import { createHash, createHmac, randomUUID } from 'crypto';
import mongoose, { ClientSession } from 'mongoose';
import EmailOutbox from '../models/EmailOutbox';
import User from '../models/User';
import Booking from '../models/Booking';
import ConceptOrder from '../models/ConceptOrder';
import BookingWorkflow from '../models/BookingWorkflow';
import { depositPaymentDto } from './depositPayment';

export const emailHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) &&
    !email.includes('..') &&
    !email.startsWith('.') &&
    !email.includes('.@')
    ? email
    : null;
}

export function emailConfig() {
  if (process.env.EMAIL_ENABLED !== 'true') return null;
  const mode = process.env.EMAIL_MODE;
  if (mode !== 'test' && mode !== 'resend') throw new Error('EMAIL_MODE must be test or resend');
  const url = new URL(process.env.EMAIL_PUBLIC_URL || '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const allowLocalHttp = local && (mode === 'test' || process.env.NODE_ENV === 'development');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:'))
  )
    throw new Error(
      'EMAIL_PUBLIC_URL must be an HTTPS origin (HTTP loopback allowed in development or test mode)',
    );
  const isolated = /^studio_(?:sepay_|email_)/.test(mongoose.connection.name || '');
  if (
    mode === 'test' &&
    (!isolated ||
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(mongoose.connection.host || '') ||
      process.env.NODE_ENV === 'production')
  )
    throw new Error(
      'Email test mode requires an isolated studio_email_* or studio_sepay_* database',
    );
  if (
    mode === 'resend' &&
    (isolated || (process.env.SEPAY_MODE === 'sandbox' && process.env.SEPAY_ENABLED === 'true'))
  )
    throw new Error('Sandbox cannot send real email');
  const from = process.env.EMAIL_FROM || '';
  if (/[\r\n]/.test(from) || !normalizeEmail(from.match(/<([^<>]+)>$/)?.[1] || from))
    throw new Error('EMAIL_FROM is invalid');
  if (mode === 'resend' && !process.env.RESEND_API_KEY)
    throw new Error('RESEND_API_KEY is missing');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16)
    throw new Error('JWT_SECRET is too short for email verification');
  return { mode, from, origin: url.origin, apiKey: process.env.RESEND_API_KEY };
}

export function verificationToken(user: string, email: string, nonce: string) {
  return createHmac('sha256', process.env.JWT_SECRET!)
    .update(`verify-email\n${user}\n${email}\n${nonce}`)
    .digest('hex');
}
const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const message = (
  from: string,
  to: string,
  subject: string,
  text: string,
  href: string,
  label: string,
) => ({
  from,
  to: [to],
  subject,
  text: `${text}\n\n${label}: ${href}`,
  html: `<div lang="vi" style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;line-height:1.6"><h1 style="font-size:22px">${escapeHtml(subject)}</h1><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p><p><a href="${escapeHtml(href)}" style="display:inline-block;background:#ff385c;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${escapeHtml(label)}</a></p><p style="font-size:13px">Nếu nút không hoạt động, mở đường dẫn: ${escapeHtml(href)}</p></div>`,
});

export function verificationMessage(job: any) {
  const { origin, from, nonce, expiresAt } = job.payload;
  const token = verificationToken(String(job.user), job.to, nonce);
  return message(
    from,
    job.to,
    'Xác minh email nhận thông báo — Yume Studio',
    `Vui lòng đăng nhập tài khoản đã yêu cầu và xác minh địa chỉ email để nhận thông báo về đơn chụp ảnh.\nĐường dẫn có hiệu lực đến ${new Date(expiresAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.\nNếu bạn không yêu cầu, hãy bỏ qua email này.`,
    `${origin}/account/verify-email#token=${token}`,
    'Xác minh email',
  );
}

export async function enqueueDepositEmail(booking: any, workflow: any, session: ClientSession) {
  const config = emailConfig();
  if (!config) return;
  const payment = depositPaymentDto(booking, workflow);
  if (payment?.status !== 'pending') return;
  const user = await User.findOne({
    _id: booking.client,
    isActive: true,
    emailVerifiedAt: { $exists: true },
  }).session(session);
  if (!user?.email || !user.emailVerifiedAt) return;
  const subject = 'Đơn chụp ảnh đã được duyệt — mời thanh toán cọc';
  const text = `Xin chào ${user.name || user.username},\nStudio đã duyệt đơn ${booking.packageName}${booking.className ? ` của lớp ${booking.className}` : ''}.\nNgày chụp: ${new Date(booking.startAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.\nTiền cọc theo thỏa thuận: ${payment.depositRequired.toLocaleString('vi-VN')} đ.\nHạn thanh toán cọc: ${payment.expiresAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} (giờ Việt Nam).\nLịch đang được giữ tạm và sẽ được xác nhận khi nhận đủ cọc trong hạn.\nĐăng nhập website để xem QR, số tiền còn thiếu và tình trạng mới nhất của đơn.`;
  const payload = message(
    config.from,
    user.email,
    subject,
    text,
    `${config.origin}/account/bookings/${booking._id}`,
    'Xem đơn và thanh toán cọc',
  );
  await EmailOutbox.updateOne(
    { dedupeKey: `deposit-approved:${booking._id}:${payment.reference}` },
    {
      $setOnInsert: {
        kind: 'deposit_approved',
        user: user._id,
        booking: booking._id,
        paymentReference: payment.reference,
        to: user.email,
        mode: config.mode,
        payload,
      },
    },
    { upsert: true, session },
  );
  // A new verified address can replace a job only before any provider dispatch.
  // Clearing the lease fences a worker which may have read the previous address.
  await EmailOutbox.updateOne(
    {
      dedupeKey: `deposit-approved:${booking._id}:${payment.reference}`,
      firstAttemptAt: { $exists: false },
      status: { $ne: 'sent' },
      $or: [
        { to: { $ne: user.email } },
        {
          status: 'skipped',
          lastError: { $in: ['recipient_changed_or_inactive', 'recipient_unverified'] },
        },
      ],
    },
    {
      $set: {
        to: user.email,
        payload,
        mode: config.mode,
        status: 'pending',
        nextAttemptAt: new Date(),
        lastError: '',
      },
      $unset: { leaseToken: 1, lockedUntil: 1 },
    },
    { session },
  );
}

export async function enqueuePendingDepositEmails(userId: string, session: ClientSession) {
  const bookings = await Booking.find({
    client: userId,
    status: 'approved',
    packageAgreement: { $exists: true },
  }).session(session);
  for (const booking of bookings) {
    const workflow = await BookingWorkflow.findOne({
      booking: booking._id,
      lifecycle: 'awaiting_deposit',
    }).session(session);
    if (workflow) await enqueueDepositEmail(booking, workflow, session);
  }
}

const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export async function processEmailOutbox(
  limit = 20,
  transport?: (payload: Record<string, any>, key: string) => Promise<string>,
) {
  const config = emailConfig();
  if (!config) return 0;
  let count = 0;
  while (count < limit) {
    const leaseToken = randomUUID(),
      now = new Date();
    const job: any = await EmailOutbox.findOneAndUpdate(
      {
        mode: config.mode,
        $or: [
          { status: 'pending', nextAttemptAt: { $lte: now } },
          { status: 'sending', lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: { status: 'sending', leaseToken, lockedUntil: new Date(+now + 60000) },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { nextAttemptAt: 1, _id: 1 } },
    ).select('+payload +leaseToken');
    if (!job) break;
    count++;
    const owned = { _id: job._id, leaseToken, status: 'sending' };
    const finish = (status: string, extra: Record<string, unknown> = {}) =>
      EmailOutbox.updateOne(owned, {
        $set: { status, ...extra },
        $unset: { leaseToken: 1, lockedUntil: 1 },
      });
    const skip = (reason: string) =>
      finish(job.deliveryUncertain ? 'delivery_unknown' : 'skipped', { lastError: reason });
    if (job.firstAttemptAt && +now - +job.firstAttemptAt >= RETRY_WINDOW_MS) {
      await finish('delivery_unknown', { lastError: 'delivery_unknown_retry_window_expired' });
      continue;
    }
    let attempted = false;
    try {
      const user = await User.findOne({ _id: job.user, isActive: true, email: job.to }).select(
        '+emailVerification',
      );
      if (!user) {
        await skip('recipient_changed_or_inactive');
        continue;
      }
      if (job.kind === 'verify_email') {
        const hash = emailHash(verificationToken(String(job.user), job.to, job.payload.nonce));
        if (
          user.emailVerifiedAt ||
          user.emailVerification?.tokenHash !== hash ||
          !user.emailVerification ||
          user.emailVerification.expiresAt <= new Date()
        ) {
          await skip('verification_superseded_or_expired');
          continue;
        }
      } else if (job.kind === 'concept_update') {
        if (
          !user.emailVerifiedAt ||
          !(await ConceptOrder.exists({ _id: job.conceptOrder, client: user._id }))
        ) {
          await skip('concept_recipient_invalid');
          continue;
        }
      } else {
        if (!user.emailVerifiedAt) {
          await skip('recipient_unverified');
          continue;
        }
        const booking = await Booking.findById(job.booking);
        const workflow = await BookingWorkflow.findOne({ booking: job.booking });
        const payment = booking && depositPaymentDto(booking, workflow);
        if (
          !user.emailVerifiedAt ||
          !booking ||
          String(booking.client) !== String(job.user) ||
          payment?.status !== 'pending' ||
          payment.reference !== job.paymentReference
        ) {
          await skip('deposit_no_longer_pending');
          continue;
        }
      }
      const payload = job.kind === 'verify_email' ? verificationMessage(job) : job.payload;
      const stamp = await EmailOutbox.updateOne(owned, {
        $set: {
          ...(!job.firstAttemptAt ? { firstAttemptAt: new Date() } : {}),
          deliveryUncertain: true,
        },
      });
      if (!stamp.matchedCount) continue;
      const dispatch = await EmailOutbox.findOne(owned).select('lockedUntil firstAttemptAt');
      if (!dispatch || !dispatch.lockedUntil || +dispatch.lockedUntil <= Date.now()) continue;
      if (dispatch.firstAttemptAt && Date.now() - +dispatch.firstAttemptAt >= RETRY_WINDOW_MS) {
        await finish('delivery_unknown', { lastError: 'delivery_unknown_retry_window_expired' });
        continue;
      }
      attempted = true;
      if (transport || config.mode === 'test') {
        const providerId = transport ? await transport(payload, job.dedupeKey) : `test-${job._id}`;
        await finish('sent', {
          sentAt: new Date(),
          providerId,
          testMessage: payload,
          lastError: '',
          deliveryUncertain: false,
        });
      } else {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': job.dedupeKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          const error = new Error(`resend_http_${response.status}`) as Error & {
            permanent?: boolean;
            definitive?: boolean;
          };
          error.permanent = response.status < 500 && ![408, 409, 429].includes(response.status);
          error.definitive = response.status < 500 && ![408, 409].includes(response.status);
          throw error;
        }
        const body = (await response.json()) as { id?: string };
        if (!body.id) throw new Error('resend_missing_message_id');
        await finish('sent', {
          sentAt: new Date(),
          providerId: body.id,
          lastError: '',
          deliveryUncertain: false,
        });
      }
    } catch (error) {
      const permanent = (error as { permanent?: boolean }).permanent;
      const uncertain =
        job.deliveryUncertain || (attempted && !(error as { definitive?: boolean }).definitive);
      await finish(
        permanent || job.attempts >= 10 ? (uncertain ? 'delivery_unknown' : 'failed') : 'pending',
        {
          deliveryUncertain: uncertain,
          lastError:
            error instanceof Error && /^resend_/.test(error.message)
              ? error.message
              : 'email_delivery_or_database_error',
          nextAttemptAt: new Date(
            Date.now() + Math.min(60 * 60 * 1000, 30000 * 2 ** Math.min(job.attempts - 1, 7)),
          ),
        },
      );
    }
  }
  return count;
}

export function startEmailWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processEmailOutbox();
    } catch {
      console.error('[Email] Worker failed; pending jobs will retry.');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 15000);
  timer.unref();
  return timer;
}
