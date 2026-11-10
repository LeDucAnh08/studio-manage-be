import { createHash } from 'crypto';
import { Types } from 'mongoose';
import Booking from '../models/Booking';
import BookingWorkflow from '../models/BookingWorkflow';
import RentalOrder from '../models/RentalOrder';
import SePayReceipt from '../models/SePayReceipt';
import { depositPaymentDto, sandboxUiEnabled, sepayConfig } from './depositPayment';
import { rentalPaymentDto } from './rentalCheckout';
import { ingestSePayPayload, processSePayReceipt } from './sepay';
import { WorkflowProblem } from './workflowTransactions';

export async function simulateSandboxDeposit(
  actor: { _id: Types.ObjectId; roles: number[] },
  reference: unknown,
  key: unknown,
) {
  if (!sandboxUiEnabled()) throw new WorkflowProblem(404, 'Không có chức năng này.');
  if (
    typeof reference !== 'string' ||
    !/^(?:RENT|YUME)[A-F0-9]{16}$/.test(reference) ||
    typeof key !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(key)
  )
    throw new WorkflowProblem(400, 'Mã thanh toán hoặc khóa gửi không hợp lệ.');
  const config = sepayConfig();
  const staff = actor.roles.some((role) => [0, 1, 5].includes(role));
  let payment;
  let createdAt: Date | undefined;
  if (reference.startsWith('RENT')) {
    const order = await RentalOrder.findOne({
      'depositPayment.reference': reference,
      ...(!staff ? { client: actor._id } : {}),
    })
      .select('+depositPayment')
      .lean();
    if (order) {
      payment = rentalPaymentDto(order);
      createdAt = new Date(order.depositPayment.createdAt);
    }
  } else {
    const workflow = await BookingWorkflow.findOne({
      'depositPayment.reference': reference,
    }).lean<{ booking: Types.ObjectId; depositPayment: { createdAt: Date } }>();
    const booking = workflow
      ? await Booking.findOne({
          _id: workflow.booking,
          ...(!staff ? { client: actor._id } : {}),
        }).lean()
      : null;
    if (booking) {
      payment = depositPaymentDto(booking, workflow);
      createdAt = new Date(workflow!.depositPayment!.createdAt);
    }
  }
  if (!payment) throw new WorkflowProblem(404, 'Không tìm thấy thanh toán thử của bạn.');
  const hash = createHash('sha256').update(`${actor._id}:${reference}:${key}`).digest('hex');
  const bankReference = 'LOCAL-UI-' + hash.slice(0, 40);
  const prior = await SePayReceipt.findOne({ mode: 'sandbox', bankReference });
  if (prior) {
    await processSePayReceipt(prior._id);
    return { status: (await SePayReceipt.findById(prior._id))!.status };
  }
  if (payment.status !== 'pending' || payment.amount <= 0)
    throw new WorkflowProblem(409, 'Đơn không còn trong thời hạn đặt cọc. Hãy tải lại hồ sơ.');
  const id = await ingestSePayPayload({
    id: parseInt(hash.slice(0, 12), 16) || 1,
    gateway: config.bankGateway,
    accountNumber: config.accountNumber,
    code: reference,
    content: reference,
    transferType: 'in',
    transferAmount: payment.amount,
    // Stable simulated bank time keeps concurrent retries byte-for-byte identical.
    transactionDate: new Date(+createdAt! + 7 * 3600000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' '),
    referenceCode: bankReference,
  });
  return { status: (await SePayReceipt.findById(id))!.status };
}
