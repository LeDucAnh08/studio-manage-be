import Booking from '../models/Booking';
import BookingWorkflow from '../models/BookingWorkflow';
import User from '../models/User';
import { createDepositPayment, sepayConfig } from './depositPayment';
import { withResourceTransaction, WorkflowProblem } from './workflowTransactions';

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
      }
      result.push({ bookingId: String(booking._id), action: apply ? 'created' : 'would-create' });
    };
    if (apply) await withResourceTransaction(update);
    else await update();
  }
  return result;
}
