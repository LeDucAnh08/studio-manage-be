import { ClientSession } from 'mongoose';
import Order from '../models/ConceptOrder';
import Album from '../models/ConceptAlbum';
import { confirm, enqueueConceptEmail, event, ledger } from './conceptBooking';
import { normalizeBankGateway, sepayConfig } from './depositPayment';

export async function applyConceptReceipt(
  receipt: any,
  session: ClientSession,
  config: ReturnType<typeof sepayConfig>,
) {
  const codes = [
    ...new Set<string>(receipt.content.toUpperCase().match(/\bCONC[A-F0-9]{16}\b/g) || []),
  ];
  const order =
    codes.length === 1
      ? await Order.findOne({ 'paymentRequests.reference': codes[0] }).session(session)
      : null;
  const request = order?.paymentRequests.find((p) => p.reference === codes[0]);
  if (order) receipt.conceptOrder = order._id;
  let reason: string | undefined;
  if (receipt.direction !== 'in') {
    receipt.status = 'ignored';
    reason = 'Giao dịch tiền ra';
  } else if (
    receipt.hasConflict ||
    codes.length !== 1 ||
    (receipt.code && receipt.code.toUpperCase() !== codes[0])
  )
    reason = 'Mã thanh toán không khớp';
  else if (!order || !request) reason = 'Không tìm thấy yêu cầu thu concept';
  else if (
    receipt.mode !== config.mode ||
    request.mode !== config.mode ||
    request.bankCode !== config.bankCode ||
    request.accountNumber !== config.accountNumber ||
    receipt.accountNumber !== request.accountNumber ||
    receipt.gateway !== normalizeBankGateway(config.bankGateway) ||
    receipt.gateway !== request.bankGateway
  )
    reason = 'Sai cấu hình tài khoản/ngân hàng';
  else if (
    request.status !== 'pending' ||
    ['expired', 'cancelled', 'completed'].includes(order.status)
  )
    reason = 'Yêu cầu thu không còn hiệu lực';
  else if (
    +request.expiresAt! <= Date.now() ||
    +receipt.transactionDate >= +request.expiresAt! ||
    +receipt.transactionDate < +request.createdAt! - 1000 ||
    +receipt.transactionDate > Date.now() + 300000
  )
    reason = 'Tiền đến ngoài thời hạn thanh toán';
  else if (receipt.amount > request.amount - request.received)
    reason = 'Số tiền vượt khoản còn thiếu';
  else {
    const complete = request.received + receipt.amount === request.amount;
    if (request.kind === 'deposit' && complete) await confirm(order, session);
    await ledger(
      order,
      receipt.amount,
      request.kind,
      session,
      receipt,
      undefined,
      receipt.bankReference || receipt.providerTransactionId,
    );
    request.received += receipt.amount;
    if (complete) request.status = 'paid';
    if (complete && ['extra', 'revision'].includes(request.kind)) {
      const album = await Album.findOne({ order: order._id }).session(session);
      if (album) {
        if (request.kind === 'extra' && album.status === 'awaiting_extra') album.status = 'queued';
        const paid = album.paidRequests.find((p: any) => p.reference === request.reference);
        if (paid) {
          paid.status = 'paid';
          album.markModified('paidRequests');
        }
        album.version += 1;
        await album.save({ session });
      }
    }
    order.version += 1;
    event(
      order,
      'payment',
      complete && request.kind === 'deposit'
        ? 'Đã nhận đủ cọc; lịch đã xác nhận.'
        : `Đã nhận ${receipt.amount} đ cho khoản ${{ deposit: 'cọc', balance: 'còn lại', extra: 'ảnh thêm', revision: 'chỉnh thêm' }[request.kind]}.`,
    );
    await order.save({ session });
    await enqueueConceptEmail(order, session);
    receipt.status = 'applied';
    receipt.conceptPayment = order.payments[order.payments.length - 1]._id;
  }
  if (reason) {
    receipt.status = receipt.status === 'ignored' ? 'ignored' : 'review';
    receipt.reason = reason;
  }
  await receipt.save({ session });
}
