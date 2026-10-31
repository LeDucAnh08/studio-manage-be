import mongoose from 'mongoose';
import Booking from '../models/Booking';
import BookingWorkflow from '../models/BookingWorkflow';
import Schedule from '../models/Schedule';
import { withResourceTransaction } from './workflowTransactions';
import { vietnamDay } from '../utils/rentalPeriod';

export const BOOKING_EXPIRY_REASON =
  'Tự động hủy vì đã quá ngày chụp dự kiến mà yêu cầu chưa được duyệt.';
export const PACKAGE_DEPOSIT_EXPIRY_REASON =
  'Tự động hủy vì hết hạn giữ lịch mà chưa ghi nhận đủ tiền cọc. Số tiền đã ghi nhận sẽ được đối soát hoàn lại.';

export const expirePackageReservations = async (now = new Date()): Promise<number> => {
  if (mongoose.connection.readyState !== 1) return 0;
  const filter = {
    'packageReservation.status': 'held',
    'packageReservation.expiresAt': { $lte: now },
  };
  const candidates = await BookingWorkflow.find(filter).select('_id booking').lean();
  let count = 0;
  for (const candidate of candidates) {
    const expired = await withResourceTransaction(async (session) => {
      const workflow = await BookingWorkflow.findOne({ ...filter, _id: candidate._id }).session(
        session,
      );
      if (!workflow || workflow.resources.schedule) return false;
      const net = workflow.payments.reduce(
        (sum: number, payment: any) =>
          sum + (payment.kind === 'refund' ? -payment.amount : payment.amount),
        0,
      );
      if (net >= (workflow.quote?.depositRequired ?? Infinity)) return false;
      const booking = await Booking.findById(workflow.booking).session(session);
      if (!booking?.packageAgreement || booking.status !== 'approved') return false;
      booking.status = 'cancelled';
      booking.cancelledAt = now;
      booking.cancellationReason = PACKAGE_DEPOSIT_EXPIRY_REASON;
      booking.events.push(
        { audience: 'client', message: PACKAGE_DEPOSIT_EXPIRY_REASON, at: now },
        { audience: 'admin', message: PACKAGE_DEPOSIT_EXPIRY_REASON, at: now },
      );
      workflow.packageReservation!.status = 'expired';
      workflow.lifecycle = 'cancelled';
      workflow.version += 1;
      workflow.memberEntry.opened = false;
      workflow.memberEntry.closedAt = now;
      workflow.events.push({
        action: 'package.expire',
        audience: 'client',
        message: PACKAGE_DEPOSIT_EXPIRY_REASON,
        at: now,
      });
      await booking.save({ session });
      await workflow.save({ session });
      return true;
    });
    if (expired) count += 1;
  }
  return count;
};

export const bookingExpiryCutoff = (now = new Date()) => vietnamDay(now);

export const expirePendingBookings = async (now = new Date()): Promise<number> => {
  if (mongoose.connection.readyState !== 1) return 0;
  const filter = { status: 'pending', startAt: { $lt: bookingExpiryCutoff(now) } };
  const expired = await Booking.find(filter).select('_id').lean();
  let count = await expirePackageReservations(now);
  for (const candidate of expired) {
    const cancelled = await withResourceTransaction(async (session) => {
      const booking = await Booking.findOne({ ...filter, _id: candidate._id }).session(session);
      if (!booking) return false;
      const workflow = await BookingWorkflow.findOne({ booking: booking._id }).session(session);
      // Only untouched intake requests expire. Never cancel an inconsistent legacy
      // record that already has money, a quote, or committed operational resources.
      if (
        booking.costumeHold?.status === 'transferred' ||
        (workflow &&
          (workflow.lifecycle !== 'intake' ||
            workflow.quote ||
            workflow.payments.length ||
            workflow.resources?.schedule)) ||
        (await Schedule.exists({ workflowBooking: booking._id }).session(session))
      )
        return false;
      booking.status = 'cancelled';
      booking.cancelledAt = now;
      booking.cancellationReason = BOOKING_EXPIRY_REASON;
      if (booking.costumeHold && ['temporary', 'approved'].includes(booking.costumeHold.status)) {
        booking.costumeHold.status = 'released';
        booking.costumeHold.expiresAt = undefined;
        booking.costumeHold.releasedAt = now;
        booking.costumeHold.releaseReason = BOOKING_EXPIRY_REASON;
      }
      booking.events.push(
        { audience: 'client', message: BOOKING_EXPIRY_REASON, at: now },
        { audience: 'admin', message: BOOKING_EXPIRY_REASON, at: now },
      );
      await booking.save({ session });
      if (workflow) {
        workflow.lifecycle = 'cancelled';
        workflow.version += 1;
        workflow.memberEntry.opened = false;
        workflow.memberEntry.closedAt = now;
        workflow.events.push({
          action: 'booking.expire',
          audience: 'client',
          message: BOOKING_EXPIRY_REASON,
          at: now,
        });
        await workflow.save({ session });
      }
      return true;
    });
    if (cancelled) count += 1;
  }
  return count;
};

export const startBookingExpiry = () => {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await expirePendingBookings();
    } catch (error) {
      console.error(
        '[Booking expiry]',
        error instanceof Error ? error.message : 'Automatic cancellation failed',
      );
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 60000);
  timer.unref();
  return timer;
};
