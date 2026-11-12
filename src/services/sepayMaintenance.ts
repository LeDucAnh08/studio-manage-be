import Booking from '../models/Booking';
import BookingWorkflow from '../models/BookingWorkflow';
import User from '../models/User';
import { createDepositPayment, sepayConfig } from './depositPayment';
import { withResourceTransaction, WorkflowProblem } from './workflowTransactions';
import { enqueueDepositEmail } from './email';
import RentalOrder from '../models/RentalOrder';
import { rentalPaid, rentalPaymentSnapshot } from './rentalCheckout';

export async function backfillDepositPayments({
  username,
  apply = false,
}: { username?: string; apply?: boolean } = {}) {
  sepayConfig();
  const user = username ? await User.findOne({ username }).select('_id').lean() : undefined;
  if (username && !user) throw new WorkflowProblem(404, 'Không tìm thấy tài khoản khách hàng.');
  const candidates = await BookingWorkflow.find({
    lifecycle: 'awaiting_deposit',
    depositPayment: { $exists: false },
    'packageReservation.status': 'held',
    'packageReservation.expiresAt': { $gt: new Date() },
  })
    .select('booking')
    .lean();
  const result: { bookingId: string; action: string }[] = [];
  for (const candidate of candidates) {
    const update = async (
      session?: Parameters<Parameters<typeof withResourceTransaction>[0]>[0],
    ) => {
      const workflow = await BookingWorkflow.findOne({
        _id: candidate._id,
        lifecycle: 'awaiting_deposit',
        depositPayment: { $exists: false },
        'packageReservation.status': 'held',
        'packageReservation.expiresAt': { $gt: new Date() },
      }).session(session ?? null);
      if (!workflow) return;
      const booking = await Booking.findOne({
        _id: workflow.booking,
        status: 'approved',
        packageAgreement: { $exists: true },
        ...(user ? { client: user._id } : {}),
      }).session(session ?? null);
      if (
        !booking ||
        !workflow.quote?.acceptedAt ||
        workflow.resources.schedule ||
        booking.startAt <= new Date()
      )
        return;
      const net = workflow.payments.reduce(
        (sum: number, row: any) => sum + (row.kind === 'refund' ? -row.amount : row.amount),
        0,
      );
      if (net >= workflow.quote.depositRequired) return;
      if (apply) {
        workflow.depositPayment = createDepositPayment(booking, workflow);
        workflow.version += 1;
        await workflow.save({ session });
        if (session) await enqueueDepositEmail(booking, workflow, session);
      }
      result.push({ bookingId: String(booking._id), action: apply ? 'created' : 'would-create' });
    };
    if (apply) await withResourceTransaction(update);
    else await update();
  }
  return result;
}

export async function backfillRentalDepositPayments({
  username,
  apply = false,
}: { username?: string; apply?: boolean } = {}) {
  sepayConfig();
  const user = username ? await User.findOne({ username }).select('_id').lean() : undefined;
  if (username && !user) throw new WorkflowProblem(404, 'Không tìm thấy tài khoản khách hàng.');
  const filter = {
    autoCheckout: true,
    status: 'awaiting_deposit',
    depositPayment: null,
    'reservation.status': 'held',
    'reservation.expiresAt': { $gt: new Date() },
    'quote.deposit': { $gt: 0 },
    'quote.acceptedAt': { $ne: null },
    ...(user ? { client: user._id } : {}),
  };
  const candidates = await RentalOrder.find(filter).select('_id').lean();
  const result: { rentalId: string; action: string }[] = [];
  for (const candidate of candidates) {
    const update = async (
      session?: Parameters<Parameters<typeof withResourceTransaction>[0]>[0],
    ) => {
      const order = await RentalOrder.findOne({ ...filter, _id: candidate._id })
        .select('+depositPayment')
        .session(session ?? null);
      // Never change an account/reference once money has already been recorded.
      if (!order || rentalPaid(order)) return;
      if (apply) {
        order.depositPayment = rentalPaymentSnapshot(
          order.quote!.deposit!,
          order.reservation!.expiresAt!,
        );
        order.version += 1;
        order.events.push({
          action: 'payment.prepare',
          at: new Date(),
          message: 'Đã tạo QR cọc tự động theo cấu hình SePay.',
        });
        await order.save({ session });
      }
      result.push({ rentalId: String(order._id), action: apply ? 'created' : 'would-create' });
    };
    if (apply) await withResourceTransaction(update);
    else await update();
  }
  return result;
}
