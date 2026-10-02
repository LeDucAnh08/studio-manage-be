import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Transaction from '../models/Transaction';
import Customer from '../models/Customer';
import Schedule from '../models/Schedule';
import Season from '../models/Season';
import type { UpcomingScheduleDto } from '../types/dto';
import { sendResponse } from '../utils/response';

const isPrivileged = (roles: number[]): boolean => roles.some((r) => r === 0 || r === 1);
const isPhotographer = (roles: number[]): boolean => roles.includes(3);

export const getStats = async (req: Request, res: Response): Promise<void> => {
  const {
    userId,
    months: monthsStr,
    season,
  } = req.query as { userId?: string; months?: string; season?: string };
  const privileged = isPrivileged(req.user!.roles);
  const userRoles = req.user!.roles as number[];

  const now = new Date();

  // Determine window based on season (uses season's actual date range) or rolling months fallback.
  let windowStart: Date;
  let windowEnd: Date;

  if (season) {
    const seasonDoc = await Season.findById(season).select('startDate endDate').lean();
    if (seasonDoc) {
      windowStart = new Date(seasonDoc.startDate);
      windowStart.setHours(0, 0, 0, 0);
      windowEnd = new Date(seasonDoc.endDate);
      windowEnd.setHours(23, 59, 59, 999);
    } else {
      const months = Math.max(1, Math.min(24, parseInt(monthsStr ?? '12', 10) || 12));
      windowStart = new Date(now.getFullYear(), now.getMonth() - months, now.getDate(), 0, 0, 0, 0);
      windowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    }
  } else {
    const months = Math.max(1, Math.min(24, parseInt(monthsStr ?? '12', 10) || 12));
    windowStart = new Date(now.getFullYear(), now.getMonth() - months, now.getDate(), 0, 0, 0, 0);
    windowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  }

  // Determine userId to filter — non-admin always uses own ID
  let filterUserId: mongoose.Types.ObjectId | null = null;
  if (!privileged) {
    filterUserId = req.user!._id as mongoose.Types.ObjectId;
  } else if (userId) {
    filterUserId = new mongoose.Types.ObjectId(userId);
  }

  const txFilter: Record<string, unknown> = filterUserId ? { createdBy: filterUserId } : {};
  const dateRange = { $gte: windowStart, $lte: windowEnd };

  // Customer filter
  const customerFilter: Record<string, unknown> = {
    ...(filterUserId ? { createdBy: filterUserId } : {}),
  };
  if (season) {
    customerFilter.season = season;
  } else {
    customerFilter.createdAt = dateRange;
  }

  // Merge totals + daily into one $facet aggregation, and run it in parallel with customerCount.
  type TxFacetResult = [
    {
      totals: Array<{ _id: string; total: number }>;
      daily: Array<{
        _id: { year: number; month: number; day: number };
        income: number;
        expense: number;
      }>;
    },
  ];
  const [txFacetResult, customerCount] = await Promise.all([
    Transaction.aggregate<TxFacetResult[0]>([
      { $match: { ...txFilter, date: dateRange } },
      {
        $facet: {
          totals: [{ $group: { _id: '$type', total: { $sum: '$amount' } } }],
          daily: [
            {
              $group: {
                _id: {
                  year: { $year: '$date' },
                  month: { $month: '$date' },
                  day: { $dayOfMonth: '$date' },
                  type: '$type',
                },
                total: { $sum: '$amount' },
              },
            },
            {
              $group: {
                _id: { year: '$_id.year', month: '$_id.month', day: '$_id.day' },
                income: { $sum: { $cond: [{ $eq: ['$_id.type', 'income'] }, '$total', 0] } },
                expense: { $sum: { $cond: [{ $eq: ['$_id.type', 'expense'] }, '$total', 0] } },
              },
            },
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
          ],
        },
      },
    ]),
    Customer.countDocuments(customerFilter),
  ]);

  const totalsRaw = txFacetResult[0]?.totals ?? [];
  const dailyRaw = txFacetResult[0]?.daily ?? [];
  const income = totalsRaw.find((r) => r._id === 'income')?.total ?? 0;
  const expense = totalsRaw.find((r) => r._id === 'expense')?.total ?? 0;

  const daily = dailyRaw.map((r) => ({
    label: `${r._id.year}-${String(r._id.month).padStart(2, '0')}-${String(r._id.day).padStart(2, '0')}`,
    income: r.income,
    expense: r.expense,
  }));

  // Schedule count & upcoming — only for photographers or admin
  let scheduleCount = 0;
  let upcomingSchedules: UpcomingScheduleDto[] = [];

  const showSchedules = privileged || isPhotographer(userRoles);
  if (showSchedules) {
    const shootDateFilter = { shootDate: dateRange };
    let scheduleFilter: Record<string, unknown> = { ...shootDateFilter };

    if (filterUserId) {
      scheduleFilter = {
        ...scheduleFilter,
        $or: [{ leadPhotographer: filterUserId }, { supportPhotographers: filterUserId }],
      };
    } else if (!privileged && isPhotographer(userRoles)) {
      const selfId = req.user!._id;
      scheduleFilter = {
        ...scheduleFilter,
        $or: [{ leadPhotographer: selfId }, { supportPhotographers: selfId }],
      };
    }

    const upcomingFilter: Record<string, unknown> = { ...scheduleFilter, shootDate: { $gte: now } };

    [scheduleCount, upcomingSchedules] = await Promise.all([
      Schedule.countDocuments(scheduleFilter),
      Schedule.find(upcomingFilter)
        .populate('customer', 'className school')
        .populate('leadPhotographer', 'name username')
        .sort({ shootDate: 1 })
        .limit(10)
        .lean<UpcomingScheduleDto[]>(),
    ]);
  }

  sendResponse(res, 200, true, 'OK', {
    totals: { income, expense, profit: income - expense },
    daily,
    customerCount,
    scheduleCount,
    showSchedules,
    upcomingSchedules,
  });
};
