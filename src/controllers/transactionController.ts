import { Request, Response } from 'express';
import Transaction from '../models/Transaction';
import Season from '../models/Season';
import type { TransactionResponse, TransactionSummaryRow } from '../types/dto';
import { notifyByRoles } from '../services/telegramService';
import { resolveSeasonForDate } from '../utils/seasonCache';
import { sendResponse } from '../utils/response';

const isPrivileged = (roles: number[]): boolean => roles.some((r) => r === 0 || r === 1 || r === 5);

interface TransactionQuery {
  customer?: string;
  type?: string;
  categoryId?: string;
  createdBy?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string;
  limit?: string;
  season?: string;
}

const buildFilter = (q: TransactionQuery) => {
  const filter: Record<string, unknown> = {};
  if (q.customer) filter.customer = q.customer;
  if (q.type) filter.type = q.type;
  if (q.categoryId) filter.categoryId = q.categoryId;
  if (q.createdBy) filter.createdBy = q.createdBy;
  if (q.dateFrom || q.dateTo) {
    const dateRange: Record<string, Date> = {};
    if (q.dateFrom) dateRange.$gte = new Date(q.dateFrom);
    if (q.dateTo) dateRange.$lte = new Date(q.dateTo);
    filter.date = dateRange;
  }
  return filter;
};

export const getAll = async (req: Request, res: Response): Promise<void> => {
  const { page = '1', limit = '20', season, ...rest } = req.query as TransactionQuery;
  const filter = buildFilter(rest);
  if (!isPrivileged(req.user!.roles)) {
    filter.createdBy = req.user!._id;
  }
  // When a season is selected and the user hasn't specified an explicit date range,
  // use the season's date range so overhead transactions (without a customer) are included.
  if (season && !rest.dateFrom && !rest.dateTo) {
    const seasonDoc = await Season.findById(season).select('startDate endDate').lean();
    if (seasonDoc) {
      const start = new Date(seasonDoc.startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(seasonDoc.endDate);
      end.setHours(23, 59, 59, 999);
      filter.date = { $gte: start, $lte: end };
    }
  }
  const skip = (Number(page) - 1) * Number(limit);
  const USER_FIELDS = '_id username name roles isActive createdAt';
  const CUSTOMER_FIELDS =
    '_id className school contactName contactPhone contactAddress total totalMale totalFemale notes createdAt';
  const [data, total] = await Promise.all([
    Transaction.find(filter)
      .populate('customer', CUSTOMER_FIELDS)
      .populate('categoryId')
      .populate('createdBy', USER_FIELDS)
      .sort({ date: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean<TransactionResponse[]>(),
    Transaction.countDocuments(filter),
  ]);
  sendResponse(res, 200, true, 'OK', data, { total, page: Number(page), limit: Number(limit) });
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  const tx = await Transaction.findById(req.params.id)
    .populate('customer')
    .populate('categoryId')
    .populate('createdBy')
    .lean<TransactionResponse | null>();
  if (!tx) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'OK', tx);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const createdBy =
    isPrivileged(req.user!.roles) && req.body.createdBy ? req.body.createdBy : req.user!._id;
  const payload = { ...req.body, createdBy };
  delete payload.workflowBooking;
  delete payload.workflowPayment;
  delete payload.rentalOrder;
  delete payload.rentalPayment;
  if (!payload.season) {
    payload.season = await resolveSeasonForDate(payload.date);
  }
  const tx = await Transaction.create(payload);
  sendResponse(res, 201, true, 'Tạo giao dịch thành công', tx);

  // Fire-and-forget: thông báo admin/kế toán khi có giao dịch mới
  void (async () => {
    try {
      const typeLabel = tx.type === 'income' ? '💰 Thu' : '💸 Chi';
      const amount = tx.amount?.toLocaleString('vi-VN') ?? '0';
      const creatorName = req.user!.name ?? req.user!.username;
      const text =
        `🔔 <b>Giao dịch mới</b>\n` +
        `${typeLabel}: <b>${amount} đ</b>\n` +
        `Người tạo: ${creatorName}${tx.description ? `\nMô tả: ${tx.description}` : ''}`;
      // Thông báo cho Superadmin (0), Admin (1), Kế toán (5)
      await notifyByRoles([0, 1, 5], text);
    } catch (e) {
      console.error('[Telegram] transaction notification failed:', e);
    }
  })();
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const existing = await Transaction.findById(req.params.id)
    .select('workflowPayment rentalPayment')
    .lean();
  if (existing?.workflowPayment || existing?.rentalPayment) {
    sendResponse(
      res,
      409,
      false,
      'Booking payment records must be changed through the booking workflow',
    );
    return;
  }
  const updateData = { ...req.body };
  delete updateData.workflowBooking;
  delete updateData.workflowPayment;
  delete updateData.rentalOrder;
  delete updateData.rentalPayment;
  if (!isPrivileged(req.user!.roles)) {
    delete updateData.createdBy;
  }
  // Nếu đổi ngày mà client không gửi season, tự tính lại
  if (updateData.date && !updateData.season) {
    updateData.season = await resolveSeasonForDate(updateData.date);
  }
  const tx = await Transaction.findByIdAndUpdate(req.params.id, updateData, {
    new: true,
    runValidators: true,
  });
  if (!tx) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Cập nhật thành công', tx);
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const existing = await Transaction.findById(req.params.id)
    .select('workflowPayment rentalPayment')
    .lean();
  if (existing?.workflowPayment || existing?.rentalPayment) {
    sendResponse(
      res,
      409,
      false,
      'Booking payment records cannot be deleted through the legacy route',
    );
    return;
  }
  const tx = await Transaction.findByIdAndDelete(req.params.id);
  if (!tx) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Đã xóa giao dịch');
};

export const getSummary = async (req: Request, res: Response): Promise<void> => {
  const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string };
  const matchDate: Record<string, Date> = {};
  if (dateFrom) matchDate.$gte = new Date(dateFrom);
  if (dateTo) matchDate.$lte = new Date(dateTo);

  const dateFilter = Object.keys(matchDate).length ? { date: matchDate } : {};
  const createdByFilter = isPrivileged(req.user!.roles) ? {} : { createdBy: req.user!._id };

  const rows = await Transaction.aggregate([
    { $match: { ...dateFilter, ...createdByFilter } },
    {
      $group: {
        _id: { customer: '$customer', type: '$type' },
        total: { $sum: '$amount' },
      },
    },
    {
      $group: {
        _id: '$_id.customer',
        income: {
          $sum: { $cond: [{ $eq: ['$_id.type', 'income'] }, '$total', 0] },
        },
        expense: {
          $sum: { $cond: [{ $eq: ['$_id.type', 'expense'] }, '$total', 0] },
        },
      },
    },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customer',
      },
    },
    {
      $project: {
        customer: { $arrayElemAt: ['$customer', 0] },
        income: 1,
        expense: 1,
        profit: { $subtract: ['$income', '$expense'] },
      },
    },
    { $sort: { 'customer.className': 1 } },
  ]);

  sendResponse(res, 200, true, 'OK', rows);
};
