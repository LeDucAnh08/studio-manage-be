import { Request, Response } from 'express';
import Transaction from '../models/Transaction';
import type { TransactionResponse, TransactionSummaryRow } from '../types/dto';
import { sendResponse } from '../utils/response';

const isPrivileged = (roles: number[]): boolean => roles.some((r) => r === 0 || r === 1);
const USER_FIELDS = '_id username name roles isActive createdAt';

interface TransactionQuery {
  customer?: string;
  type?: string;
  categoryId?: string;
  createdBy?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  refundStatus?: string;
  sort?: string;
  page?: string;
  limit?: string;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildFilter = (q: TransactionQuery) => {
  const filter: Record<string, unknown> = {};
  if (q.customer) filter.customer = q.customer;
  if (q.type) filter.type = q.type;
  if (q.categoryId) filter.categoryId = q.categoryId;
  if (q.createdBy) filter.createdBy = q.createdBy;
  if (typeof q.search === 'string' && q.search.trim()) {
    filter.description = { $regex: escapeRegex(q.search.trim()), $options: 'i' };
  }
  if (q.refundStatus === 'unrefunded') {
    if (!q.type || q.type === 'expense') {
      filter.type = 'expense';
      filter.accountantRefunded = { $ne: true };
    } else {
      filter._id = { $in: [] };
    }
  } else if (q.refundStatus === 'refunded') {
    if (!q.type || q.type === 'expense') {
      filter.type = 'expense';
      filter.accountantRefunded = true;
    } else {
      filter._id = { $in: [] };
    }
  }
  if (q.dateFrom || q.dateTo) {
    const dateRange: Record<string, Date> = {};
    if (q.dateFrom) dateRange.$gte = new Date(q.dateFrom);
    if (q.dateTo) {
      const end = new Date(q.dateTo);
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.dateTo)) {
        end.setUTCHours(23, 59, 59, 999);
      }
      dateRange.$lte = end;
    }
    filter.date = dateRange;
  }
  return filter;
};

export const getAll = async (req: Request, res: Response): Promise<void> => {
  const { page = '1', limit = '20', sort = 'date_desc', ...rest } = req.query as TransactionQuery;
  const filter = buildFilter(rest);
  if (!isPrivileged(req.user!.roles)) {
    filter.createdBy = req.user!._id;
  }
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(5000, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * limitNum;
  const sortOrder: Record<string, 1 | -1> =
    sort === 'date_asc' ? { date: 1, _id: 1 } : { date: -1, _id: -1 };
  const CUSTOMER_FIELDS =
    '_id className school contactName contactPhone contactAddress total totalMale totalFemale notes createdAt';
  const [data, total, summaryAgg] = await Promise.all([
    Transaction.find(filter)
      .populate('customer', CUSTOMER_FIELDS)
      .populate('categoryId')
      .populate('createdBy', USER_FIELDS)
      .sort(sortOrder)
      .skip(skip)
      .limit(limitNum)
      .lean<TransactionResponse[]>(),
    Transaction.countDocuments(filter),
    Transaction.aggregate<{
      _id: null;
      income: number;
      incomeCount: number;
      expense: number;
      expenseCount: number;
      unrefundedAmount: number;
      unrefundedCount: number;
    }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
          incomeCount: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, 1, 0] } },
          expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } },
          expenseCount: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, 1, 0] } },
          unrefundedAmount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$type', 'expense'] },
                    { $ne: ['$accountantRefunded', true] },
                  ],
                },
                '$amount',
                0,
              ],
            },
          },
          unrefundedCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$type', 'expense'] },
                    { $ne: ['$accountantRefunded', true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);
  const agg = summaryAgg[0];
  const income = agg?.income ?? 0;
  const expense = agg?.expense ?? 0;
  const totals = {
    income,
    incomeCount: agg?.incomeCount ?? 0,
    expense,
    expenseCount: agg?.expenseCount ?? 0,
    profit: income - expense,
    unrefundedAmount: agg?.unrefundedAmount ?? 0,
    unrefundedCount: agg?.unrefundedCount ?? 0,
  };
  sendResponse(res, 200, true, 'OK', data, { total, page: pageNum, limit: limitNum, totals });
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  const tx = await Transaction.findById(req.params.id)
    .populate('customer')
    .populate('categoryId')
    .populate('createdBy', USER_FIELDS)
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
  delete payload.conceptOrder;
  delete payload.conceptPayment;
  const tx = await Transaction.create(payload);
  sendResponse(res, 201, true, 'Tạo giao dịch thành công', tx);
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const existing = await Transaction.findById(req.params.id)
    .select('workflowPayment rentalPayment conceptPayment')
    .lean();
  if (existing?.workflowPayment || existing?.rentalPayment || existing?.conceptPayment) {
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
  delete updateData.conceptOrder;
  delete updateData.conceptPayment;
  if (!isPrivileged(req.user!.roles)) {
    delete updateData.createdBy;
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
    .select('workflowPayment rentalPayment conceptPayment')
    .lean();
  if (existing?.workflowPayment || existing?.rentalPayment || existing?.conceptPayment) {
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
        from: 'classes',
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
