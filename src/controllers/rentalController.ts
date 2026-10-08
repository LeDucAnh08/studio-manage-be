import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { ClientSession, isValidObjectId, Types } from 'mongoose';
import RentalOrder from '../models/RentalOrder';
import Costume from '../models/Costume';
import Category from '../models/Category';
import Transaction from '../models/Transaction';
import { sendResponse } from '../utils/response';
import { withResourceTransaction, WorkflowProblem } from '../services/workflowTransactions';
import { ensureRentalAvailability, vietnamDay } from '../services/rentalAvailability';

const roles = (req: Request, ...allowed: number[]) =>
  req.user!.roles.some((role) => allowed.includes(role));
const assert = (ok: unknown, message: string, status = 409): void => {
  if (!ok) throw new WorkflowProblem(status, message);
};
const integer = (value: unknown, minimum = 0, maximum = 100_000_000_000): number => {
  assert(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    'Số tiền/số lượng không hợp lệ.',
    400,
  );
  return value as number;
};
const text = (value: unknown, max: number, required = false): string => {
  assert(value === undefined || typeof value === 'string', 'Nội dung phải là chuỗi.', 400);
  const result = typeof value === 'string' ? value.trim() : '';
  assert(
    result.length <= max && (!required || result.length > 0),
    'Nội dung thiếu hoặc quá dài.',
    400,
  );
  return result;
};
const dates = (receive: unknown, returned: unknown, future = true) => {
  const read = (value: unknown) => {
    assert(
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
      'Ngày phải theo định dạng YYYY-MM-DD.',
      400,
    );
    const result = new Date(`${value}T00:00:00+07:00`);
    assert(
      Number.isFinite(result.getTime()) &&
        new Date(result.getTime() + 25200000).toISOString().slice(0, 10) === value,
      'Ngày không hợp lệ.',
      400,
    );
    return result;
  };
  const receiveDate = read(receive),
    returnDate = read(returned);
  assert(
    (!future || receiveDate >= vietnamDay(new Date())) &&
      returnDate >= receiveDate &&
      returnDate.getTime() - receiveDate.getTime() <= 365 * 86400000,
    'Kỳ thuê phải từ hôm nay, tối đa 366 ngày.',
    400,
  );
  return { receiveDate, returnDate };
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (req: Request) => {
  const value = req.get('Idempotency-Key');
  assert(value && /^[a-zA-Z0-9_-]{8,128}$/.test(value), 'Cần Idempotency-Key hợp lệ.', 400);
  return value!;
};
const net = (order: any): number =>
  order.payments.reduce(
    (sum: number, row: any) => sum + (row.kind === 'refund' ? -row.amount : row.amount),
    0,
  );
const payable = (order: any): number =>
  order.status === 'cancelled'
    ? order.change.finalFee
    : order.returnedAt
      ? order.settlement?.acceptedAt
        ? order.settlement.total
        : order.quote.fee
      : order.quote.fee + order.quote.deposit;
const financials = (order: any) => {
  const received = net(order),
    total = payable(order);
  return {
    netReceived: received,
    payable: total,
    due: Math.max(0, total - received),
    refundDue:
      order.status === 'cancelled' || order.settlement?.acceptedAt
        ? Math.max(0, received - total)
        : 0,
  };
};
const dto = (order: any, req: Request) => {
  const finance = roles(req, 0, 1, 2, 5, 6);
  const quote = (value: any) =>
    value
      ? {
          ...value,
          ...(!finance
            ? {
                fee: undefined,
                deposit: undefined,
                lines: value.lines.map((line: any) => ({ ...line, unitPrice: undefined })),
              }
            : {}),
        }
      : null;
  return {
    _id: order._id,
    version: order.version,
    status: order.status,
    contactName: order.contactName,
    phone: roles(req, 5) && !roles(req, 0, 1, 2, 4, 6) ? undefined : order.phone,
    note: order.note,
    requestedLines: order.requestedLines.map((line: any) => ({
      ...line,
      ...(!finance ? { unitPrice: undefined } : {}),
    })),
    requestedReceiveDate: order.requestedReceiveDate,
    requestedReturnDate: order.requestedReturnDate,
    quote: quote(order.quote),
    quoteHistory: order.quoteHistory.map(quote),
    ...(finance && order.quote?.acceptedAt
      ? {
          payment: financials(order),
          payments: order.payments.map(({ kind, amount, method, reference, at }: any) => ({
            kind,
            amount,
            method,
            reference,
            at,
          })),
        }
      : {}),
    readyForHandover:
      !!order.quote?.acceptedAt && net(order) === order.quote.fee + order.quote.deposit,
    checkedOutAt: order.checkedOutAt,
    returnedAt: order.returnedAt,
    returns: order.returns,
    settlement: finance ? order.settlement : undefined,
    settlementHistory: finance ? order.settlementHistory : undefined,
    change: order.change ? { ...order.change, ...(!finance ? { finalFee: undefined } : {}) } : null,
    changeHistory: finance ? order.changeHistory : undefined,
    events: order.events.map(({ action, at, message }: any) => ({ action, at, message })),
    feedback: order.feedback,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
};
const owned = async (req: Request, session?: ClientSession) => {
  assert(isValidObjectId(req.params.id), 'Không tìm thấy đơn thuê.', 404);
  const query = RentalOrder.findById(req.params.id);
  if (session) query.session(session);
  const order: any = await query;
  assert(
    order && (!roles(req, 6) || String(order.client) === String(req.user!._id)),
    'Không tìm thấy đơn thuê.',
    404,
  );
  return order;
};
const respondProblem = (res: Response, error: unknown) => {
  const problem = error as WorkflowProblem;
  if (!problem.status) console.error('[rental]', problem.message);
  sendResponse(
    res,
    problem.status ?? 500,
    false,
    problem.status ? problem.message : 'Không thể xử lý đơn thuê.',
  );
};
const readLines = async (input: unknown, session: ClientSession, quoted: boolean) => {
  assert(
    Array.isArray(input) && input.length >= 1 && input.length <= 30,
    'Cần 1–30 dòng trang phục/phụ kiện.',
    400,
  );
  const seen = new Set<string>();
  const result = [];
  for (const value of input as any[]) {
    assert(isValidObjectId(value?.costumeId), 'Mẫu không hợp lệ.', 400);
    const costume = await Costume.findById(value.costumeId).session(session).lean();
    const size = text(value.size, 12, true);
    assert(
      costume?.isRentalItem &&
        costume.inventory.some(
          (row) => row.size === size && row.condition === 'good' && row.quantity > 0,
        ),
      'Mẫu hoặc kích cỡ chưa được phép cho thuê.',
      400,
    );
    const rowKey = `${value.costumeId}:${size}`;
    assert(!seen.has(rowKey), 'Mỗi mẫu và kích cỡ chỉ chọn một lần.', 400);
    seen.add(rowKey);
    result.push({
      costumeId: new Types.ObjectId(value.costumeId),
      name: costume!.name,
      size,
      quantity: integer(value.quantity, 1, 10000),
      unitPrice: quoted ? integer(value.unitPrice) : (costume!.rentalPrice ?? 0),
    });
  }
  return result;
};
const event = (order: any, req: Request, action: string, message: string) =>
  order.events.push({ action, actor: req.user!._id, at: new Date(), message });
const completeIfSettled = (order: any) => {
  if (
    order.status === 'returned' &&
    order.settlement?.acceptedAt &&
    net(order) === order.settlement.total
  )
    order.status = 'completed';
};

export const createRental = async (req: Request, res: Response): Promise<void> => {
  try {
    const creationKey = key(req);
    const input = {
      contactName: text(req.body.contactName, 120, true),
      phone: text(req.body.phone, 20, true),
      note: text(req.body.note, 2000),
      ...dates(req.body.receiveDate, req.body.returnDate, false),
    };
    assert(/^[+\d][\d\s.-]{7,19}$/.test(input.phone), 'Số điện thoại không hợp lệ.', 400);
    let result: any,
      replay = false;
    await withResourceTransaction(async (session) => {
      assert(Array.isArray(req.body.lines), 'Danh sách mẫu không hợp lệ.', 400);
      // Snapshot price is deliberately excluded: a catalog update must not break a retry.
      const fingerprint = hash({
        ...input,
        lines: req.body.lines.map((row: any) => ({
          costumeId: row?.costumeId,
          size: row?.size,
          quantity: row?.quantity,
        })),
      });
      const existing: any = await RentalOrder.findOne({
        client: req.user!._id,
        creationKey,
      }).session(session);
      if (existing) {
        assert(existing.creationFingerprint === fingerprint, 'Khóa gửi đã dùng cho nội dung khác.');
        result = existing;
        replay = true;
        return;
      }
      assert(input.receiveDate >= vietnamDay(new Date()), 'Ngày nhận phải từ hôm nay.', 400);
      const lines = await readLines(req.body.lines, session, false);
      [result] = await RentalOrder.create(
        [
          {
            client: req.user!._id,
            creationKey,
            creationFingerprint: fingerprint,
            contactName: input.contactName,
            phone: input.phone,
            note: input.note,
            requestedLines: lines,
            requestedReceiveDate: input.receiveDate,
            requestedReturnDate: input.returnDate,
            events: [
              {
                action: 'requested',
                at: new Date(),
                message: 'Khách gửi yêu cầu thuê; chưa giữ hàng.',
              },
            ],
          },
        ],
        { session },
      );
    });
    sendResponse(
      res,
      replay ? 200 : 201,
      true,
      'Đã nhận yêu cầu thuê.',
      dto(result.toObject(), req),
    );
  } catch (error) {
    respondProblem(res, error);
  }
};
export const listRentals = async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Number(req.query.page ?? 1),
      limit = Number(req.query.limit ?? 20);
    assert(
      Number.isSafeInteger(page) &&
        page >= 1 &&
        page <= 100000 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100,
      'Phân trang không hợp lệ.',
      400,
    );
    const filter = roles(req, 6) ? { client: req.user!._id } : {};
    const [rows, total] = await Promise.all([
      RentalOrder.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      RentalOrder.countDocuments(filter),
    ]);
    res.json({
      success: true,
      data: rows.map((row) => dto(row, req)),
      pagination: { total, page, limit },
    });
  } catch (error) {
    respondProblem(res, error);
  }
};
export const getRental = async (req: Request, res: Response): Promise<void> => {
  try {
    const order = await owned(req);
    sendResponse(res, 200, true, 'OK', dto(order.toObject(), req));
  } catch (error) {
    respondProblem(res, error);
  }
};

export const actRental = async (req: Request, res: Response): Promise<void> => {
  try {
    const commandKey = key(req),
      body = req.body,
      action = body.action;
    const allowed: Record<string, boolean> = {
      'quote.propose': roles(req, 0, 1, 2),
      reject: roles(req, 0, 1, 2),
      'quote.accept': roles(req, 6),
      withdraw: roles(req, 6),
      'resources.confirm': roles(req, 0, 1),
      'payment.record': roles(req, 0, 1, 5),
      handover: roles(req, 0, 1),
      return: roles(req, 0, 1),
      'settlement.propose': roles(req, 0, 1),
      'settlement.accept': roles(req, 6),
      'change.request': roles(req, 6),
      'change.propose': roles(req, 0, 1, 2),
      'change.accept': roles(req, 6),
      'change.decline': roles(req, 0, 1, 2, 6),
      'feedback.submit': roles(req, 6),
    };
    assert(
      typeof action === 'string' &&
        Object.prototype.hasOwnProperty.call(allowed, action) &&
        allowed[action],
      'Bạn không có quyền thực hiện thao tác này.',
      403,
    );
    let result: any;
    await withResourceTransaction(async (session) => {
      const order = await owned(req, session);
      const { expectedVersion: _ignored, ...payload } = body;
      const fingerprint = hash(payload);
      const prior = order.commands.find(
        (row: any) => row.key === commandKey && String(row.actor) === String(req.user!._id),
      );
      if (prior) {
        assert(prior.fingerprint === fingerprint, 'Khóa gửi đã dùng cho nội dung khác.');
        result = order;
        return;
      }
      assert(
        body.expectedVersion === order.version,
        'Hồ sơ đã thay đổi. Tải lại trước khi thao tác.',
      );
      const quote = order.quote;
      switch (action) {
        case 'quote.propose': {
          assert(
            ['requested', 'quoting'].includes(order.status),
            'Không thể thay báo giá đã được đồng ý.',
          );
          const lines = await readLines(body.lines, session, true);
          const fee = lines.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0);
          integer(fee);
          const deposit = integer(body.deposit);
          integer(fee + deposit);
          assert(
            Array.isArray(body.terms) && body.terms.length >= 1 && body.terms.length <= 20,
            'Cần điều khoản thuê và cọc.',
            400,
          );
          if (quote) order.quoteHistory.push(quote.toObject());
          order.quote = {
            version: (quote?.version ?? 0) + 1,
            lines,
            ...dates(body.receiveDate, body.returnDate),
            fee,
            deposit,
            terms: body.terms.map((term: unknown) => text(term, 1000, true)),
            proposedAt: new Date(),
          };
          order.status = 'quoting';
          break;
        }
        case 'reject':
          assert(
            ['requested', 'quoting'].includes(order.status),
            'Chỉ từ chối yêu cầu chưa đồng ý báo giá.',
          );
          order.status = 'rejected';
          event(order, req, action, text(body.note, 1000, true));
          break;
        case 'quote.accept':
          assert(
            order.status === 'quoting' && quote?.version === body.quoteVersion,
            'Báo giá không còn là phiên bản hiện tại.',
          );
          assert(
            quote.receiveDate >= vietnamDay(new Date()),
            'Ngày nhận trong báo giá đã qua; cần báo giá mới.',
          );
          quote.acceptedAt = new Date();
          order.status = quote.deposit ? 'awaiting_deposit' : 'ready_to_confirm';
          break;
        case 'withdraw':
          assert(
            ['requested', 'quoting'].includes(order.status) && !quote?.acceptedAt,
            'Chỉ rút yêu cầu trước khi đồng ý báo giá.',
          );
          order.change = {
            kind: 'cancel',
            status: 'applied',
            finalFee: 0,
            terms: [],
            note: 'Khách rút yêu cầu trước khi đồng ý báo giá.',
            at: new Date(),
            acceptedAt: new Date(),
          };
          order.status = 'cancelled';
          break;
        case 'resources.confirm':
          assert(
            order.status === 'ready_to_confirm' &&
              quote?.acceptedAt &&
              net(order) >= quote.deposit &&
              !['requested', 'proposed'].includes(order.change?.status),
            'Cần đồng ý báo giá và đủ cọc trước khi giữ hàng.',
          );
          assert(
            quote.receiveDate >= vietnamDay(new Date()),
            'Ngày nhận đã qua; cần thỏa thuận lại.',
          );
          await ensureRentalAvailability(quote, session, String(order._id));
          order.status = 'confirmed';
          break;
        case 'payment.record': {
          assert(
            quote?.acceptedAt &&
              !['requested', 'quoting', 'rejected', 'completed'].includes(order.status),
            'Chưa thể ghi nhận tiền.',
          );
          const kind = body.kind,
            amount = integer(body.amount, 1),
            method = body.method;
          assert(
            ['deposit', 'balance', 'refund'].includes(kind) &&
              ['cash', 'bank_transfer', 'other'].includes(method),
            'Loại giao dịch/phương thức không hợp lệ.',
            400,
          );
          const before = net(order),
            target = payable(order);
          if (kind === 'refund')
            assert(
              (order.status === 'cancelled' || order.settlement?.acceptedAt) &&
                amount <= before - target,
              'Chỉ hoàn số dư sau khi khách đồng ý đối soát/hủy.',
            );
          else {
            assert(
              !order.returnedAt || order.settlement?.acceptedAt,
              'Cần khách đồng ý đối soát trước khi thu phát sinh.',
            );
            assert(amount <= target - before, 'Khoản thu vượt số còn phải thu.');
            if (kind === 'deposit')
              assert(
                order.status === 'awaiting_deposit' && amount <= quote.deposit - before,
                'Khoản cọc vượt số cọc còn thiếu.',
              );
          }
          const type = kind === 'refund' ? 'expense' : 'income';
          const name =
            kind === 'refund'
              ? 'Hoàn cọc thuê'
              : kind === 'deposit'
                ? 'Cọc thuê'
                : 'Thanh toán thuê';
          let category = await Category.findOne({ name, type }).session(session);
          if (!category)
            [category] = await Category.create(
              [{ name, type, isDefault: true, createdBy: req.user!._id }],
              { session },
            );
          const paymentId = new Types.ObjectId();
          const [transaction] = await Transaction.create(
            [
              {
                rentalOrder: order._id,
                rentalPayment: paymentId,
                amount,
                type,
                categoryId: category._id,
                date: new Date(),
                createdBy: req.user!._id,
                description: `Đơn thuê ${order._id}`,
              },
            ],
            { session },
          );
          order.payments.push({
            _id: paymentId,
            kind,
            amount,
            method,
            reference: text(body.reference, 160),
            at: new Date(),
            actor: req.user!._id,
            transaction: transaction._id,
          });
          if (order.status === 'awaiting_deposit' && net(order) >= quote.deposit)
            order.status = 'ready_to_confirm';
          completeIfSettled(order);
          break;
        }
        case 'handover': {
          assert(
            order.status === 'confirmed' &&
              !['requested', 'proposed'].includes(order.change?.status),
            'Đơn chưa sẵn sàng giao hoặc đang xử lý thay đổi.',
          );
          const today = vietnamDay(new Date());
          assert(
            quote.receiveDate <= today && quote.returnDate >= today,
            'Chỉ giao trong kỳ thuê đã chốt.',
          );
          assert(
            net(order) === quote.fee + quote.deposit,
            'Cần đủ phí thuê và cọc trước khi giao.',
          );
          await ensureRentalAvailability(quote, session, String(order._id));
          order.status = 'checked_out';
          order.checkedOutAt = new Date();
          break;
        }
        case 'return': {
          assert(order.status === 'checked_out', 'Chỉ nhận trả hàng đã giao.');
          assert(
            Array.isArray(body.lines) && body.lines.length === quote.lines.length,
            'Cần kiểm tra từng dòng đã giao.',
            400,
          );
          const seen = new Set<string>();
          order.returns = [];
          for (const row of body.lines) {
            const rowKey = `${row.costumeId}:${row.size}`;
            assert(!seen.has(rowKey), 'Dòng nhận trả trùng.', 400);
            seen.add(rowKey);
            const source = quote.lines.find(
              (line: any) => String(line.costumeId) === row.costumeId && line.size === row.size,
            );
            assert(source, 'Dòng nhận trả không thuộc đơn.', 400);
            const good = integer(row.good, 0, 10000),
              damaged = integer(row.damaged, 0, 10000),
              lost = integer(row.lost, 0, 10000);
            assert(
              good + damaged + lost === source.quantity,
              'Tổng tốt/hỏng/mất phải đúng số lượng đã giao.',
              400,
            );
            const costume = await Costume.findById(source.costumeId).session(session);
            assert(costume, 'Mẫu đã bị xóa.');
            let reduction = damaged + lost;
            for (const stock of costume!.inventory)
              if (stock.size === row.size && stock.condition === 'good') {
                const take = Math.min(reduction, stock.quantity);
                stock.quantity -= take;
                reduction -= take;
              }
            assert(reduction === 0, 'Tồn tốt không khớp; cần đối soát kho trước khi nhận trả.');
            for (const [condition, quantity] of [
              ['damaged', damaged],
              ['retired', lost],
            ] as const)
              if (quantity) {
                const existing = costume!.inventory.find(
                  (stock) => stock.size === row.size && stock.condition === condition,
                );
                if (existing) existing.quantity += quantity;
                else costume!.inventory.push({ size: row.size, condition, quantity });
              }
            await costume!.save({ session });
            order.returns.push({
              costumeId: source.costumeId,
              size: row.size,
              good,
              damaged,
              lost,
            });
          }
          if (order.change && ['requested', 'proposed'].includes(order.change.status)) {
            order.change.status = 'declined';
            order.changeHistory.push(order.change.toObject());
          }
          order.status = 'returned';
          order.returnedAt = new Date();
          break;
        }
        case 'settlement.propose': {
          assert(
            order.status === 'returned' && !order.settlement?.acceptedAt,
            'Chỉ đối soát đơn đã nhận trả và chưa chốt.',
          );
          assert(
            Array.isArray(body.charges) && body.charges.length <= 30,
            'Phụ phí không hợp lệ.',
            400,
          );
          const charges = body.charges.map((row: any) => ({
            label: text(row.label, 200, true),
            amount: integer(row.amount),
          }));
          const total = integer(
            quote.fee + charges.reduce((sum: number, row: any) => sum + row.amount, 0),
          );
          if (order.settlement?.proposedAt)
            order.settlementHistory.push(order.settlement.toObject());
          order.settlement = {
            version: (order.settlement?.version ?? 0) + 1,
            charges,
            total,
            note: text(body.note, 2000, true),
            proposedAt: new Date(),
          };
          break;
        }
        case 'settlement.accept':
          assert(
            order.status === 'returned' &&
              order.settlement?.proposedAt &&
              !order.settlement.acceptedAt &&
              order.settlement.version === body.settlementVersion,
            'Đề xuất đối soát đã thay đổi.',
          );
          order.settlement.acceptedAt = new Date();
          completeIfSettled(order);
          break;
        case 'change.request': {
          assert(
            ['awaiting_deposit', 'ready_to_confirm', 'confirmed', 'checked_out'].includes(
              order.status,
            ) && !['requested', 'proposed'].includes(order.change?.status),
            'Không thể mở yêu cầu thay đổi.',
          );
          assert(
            (body.kind === 'extend' && ['confirmed', 'checked_out'].includes(order.status)) ||
              (body.kind === 'cancel' &&
                ['awaiting_deposit', 'ready_to_confirm', 'confirmed'].includes(order.status)),
            'Không hủy hàng đã giao.',
            400,
          );
          const period =
            body.kind === 'extend'
              ? dates(
                  new Date(
                    Math.max(quote.receiveDate.getTime(), vietnamDay(new Date()).getTime()) +
                      25200000,
                  )
                    .toISOString()
                    .slice(0, 10),
                  body.returnDate,
                )
              : null;
          if (period)
            assert(
              period.returnDate > quote.returnDate,
              'Ngày gia hạn phải sau ngày trả hiện tại.',
              400,
            );
          if (order.change) order.changeHistory.push(order.change.toObject());
          order.change = {
            kind: body.kind,
            status: 'requested',
            note: text(body.note, 1000, true),
            returnDate: period?.returnDate,
            at: new Date(),
          };
          break;
        }
        case 'change.propose':
          assert(
            order.change && ['requested', 'proposed'].includes(order.change.status),
            'Chưa có yêu cầu thay đổi.',
          );
          if (order.change.status === 'proposed') order.changeHistory.push(order.change.toObject());
          order.change.finalFee = integer(body.finalFee);
          assert(
            order.change.kind === 'cancel'
              ? order.change.finalFee <= quote.fee
              : order.change.finalFee >= quote.fee,
            'Giá cuối không phù hợp loại thay đổi.',
          );
          assert(
            Array.isArray(body.terms) && body.terms.length >= 1 && body.terms.length <= 20,
            'Cần điều khoản thay đổi.',
            400,
          );
          order.change.terms = body.terms.map((term: unknown) => text(term, 1000, true));
          order.change.status = 'proposed';
          break;
        case 'change.accept': {
          assert(
            order.change?.status === 'proposed' && String(order.change._id) === body.changeId,
            'Đề xuất thay đổi đã thay đổi.',
          );
          if (order.change.kind === 'extend') {
            const next = {
              ...quote.toObject(),
              version: quote.version + 1,
              returnDate: order.change.returnDate,
              fee: order.change.finalFee,
              terms: [...quote.terms, ...order.change.terms],
              acceptedAt: new Date(),
              proposedAt: order.change.at,
            };
            assert(
              next.returnDate >= vietnamDay(new Date()) &&
                next.returnDate.getTime() - next.receiveDate.getTime() <= 365 * 86400000,
              'Ngày gia hạn không hợp lệ.',
            );
            await ensureRentalAvailability(next, session, String(order._id));
            order.quoteHistory.push(quote.toObject());
            order.quote = next;
          } else {
            assert(
              ['awaiting_deposit', 'ready_to_confirm', 'confirmed'].includes(order.status),
              'Không hủy hàng đã giao.',
            );
            order.status = 'cancelled';
          }
          order.change.status = 'applied';
          order.change.acceptedAt = new Date();
          break;
        }
        case 'change.decline':
          assert(
            order.change && ['requested', 'proposed'].includes(order.change.status),
            'Không có đề xuất đang mở.',
          );
          order.change.status = 'declined';
          break;
        case 'feedback.submit':
          assert(
            order.status === 'completed' && !order.feedback?.at,
            'Chỉ đánh giá một lần sau hoàn tất.',
          );
          order.feedback = {
            rating: integer(body.rating, 1, 5),
            comment: text(body.comment, 2000),
            at: new Date(),
          };
          break;
      }
      const messages: Record<string, string> = {
        'quote.propose': 'Studio gửi báo giá thuê.',
        reject: 'Studio từ chối yêu cầu.',
        'quote.accept': 'Khách đồng ý báo giá.',
        withdraw: 'Khách rút yêu cầu thuê trước khi đồng ý báo giá.',
        'resources.confirm': 'Studio xác nhận giữ hàng.',
        'payment.record': 'Đã ghi nhận giao dịch.',
        handover: 'Studio đã giao hàng.',
        return: 'Studio đã kiểm tra và nhận trả hàng.',
        'settlement.propose': 'Studio gửi đối soát phí thuê/phát sinh.',
        'settlement.accept': 'Khách đồng ý đối soát.',
        'change.request': 'Khách yêu cầu thay đổi.',
        'change.propose': 'Studio gửi đề xuất thay đổi.',
        'change.accept': 'Khách đồng ý thay đổi.',
        'change.decline': 'Đã đóng yêu cầu thay đổi.',
        'feedback.submit': 'Khách gửi đánh giá.',
      };
      event(order, req, action, messages[action]);
      order.commands.push({ key: commandKey, actor: req.user!._id, fingerprint, action });
      order.version += 1;
      await order.save({ session });
      result = order;
    });
    sendResponse(res, 200, true, 'Đã cập nhật đơn thuê.', dto(result.toObject(), req));
  } catch (error) {
    respondProblem(res, error);
  }
};
