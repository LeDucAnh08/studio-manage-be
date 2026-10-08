import { Request, Response } from 'express';
import { PipelineStage } from 'mongoose';
import Transaction from '../models/Transaction';
import BookingWorkflow from '../models/BookingWorkflow';
import RentalOrder from '../models/RentalOrder';
import Costume from '../models/Costume';
import Schedule from '../models/Schedule';
import { financialProjection, reportPage, reportRange, DAY } from '../services/reporting';
import { vietnamDay } from '../services/rentalAvailability';
import { WorkflowProblem } from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';

const fail = (res: Response, e: unknown) => {
  if (e instanceof WorkflowProblem) sendResponse(res, e.status, false, e.message);
  else {
    console.error('[reports]', e);
    sendResponse(res, 500, false, 'Không tải được báo cáo.');
  }
};
export async function getFinanceReport(req: Request, res: Response) {
  try {
    const range = reportRange(req.query.from, req.query.to),
      page = reportPage(req.query.page);
    const view = req.query.view ?? 'cash',
      service = req.query.service ?? 'all';
    if (
      !['cash', 'agreed', 'due', 'refund'].includes(view as string) ||
      !['all', 'photography', 'rental', 'unclassified'].includes(service as string)
    )
      throw new WorkflowProblem(400, 'Bộ lọc báo cáo không hợp lệ.');
    const selected = service === 'all' ? {} : { service };
    const period = { $gte: range.start, $lt: range.until };
    const detailPage = [{ $skip: (page - 1) * 20 }, { $limit: 20 }];
    const cashStages: PipelineStage[] = [
      { $match: { date: period } },
      {
        $project: {
          date: 1,
          type: 1,
          amount: 1,
          referenceId: { $cond: ['$workflowBooking', '$workflowBooking', '$rentalOrder'] },
          service: {
            $switch: {
              branches: [
                {
                  case: {
                    $and: [
                      { $ne: [{ $ifNull: ['$workflowBooking', null] }, null] },
                      { $eq: [{ $ifNull: ['$rentalOrder', null] }, null] },
                    ],
                  },
                  then: 'photography',
                },
                {
                  case: {
                    $and: [
                      { $ne: [{ $ifNull: ['$rentalOrder', null] }, null] },
                      { $eq: [{ $ifNull: ['$workflowBooking', null] }, null] },
                    ],
                  },
                  then: 'rental',
                },
              ],
              default: 'unclassified',
            },
          },
        },
      },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: '$service',
                count: { $sum: 1 },
                income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
                expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } },
              },
            },
          ],
          rows: [{ $match: selected }, { $sort: { date: -1, _id: -1 } }, ...detailPage],
          count: [{ $match: selected }, { $count: 'total' }],
        },
      },
    ];
    const detailMatch = {
      ...selected,
      ...(view === 'agreed'
        ? { valueAt: period }
        : view === 'due'
          ? { due: { $gt: 0 } }
          : { refundDue: { $gt: 0 } }),
    };
    const businessStages: PipelineStage[] = [
      ...financialProjection('photography'),
      {
        $unionWith: {
          coll: RentalOrder.collection.name,
          pipeline: financialProjection('rental') as any[],
        },
      },
      {
        $facet: {
          snapshot: [
            {
              $group: {
                _id: '$service',
                count: { $sum: 1 },
                agreedValue: { $sum: '$fee' },
                due: { $sum: '$due' },
                refundDue: { $sum: '$refundDue' },
                depositHeld: { $sum: '$depositHeld' },
                unsettledSurplus: { $sum: '$unsettledSurplus' },
              },
            },
          ],
          accepted: [
            { $match: { valueAt: period } },
            {
              $group: {
                _id: '$service',
                count: { $sum: 1 },
                serviceValue: { $sum: { $cond: [{ $eq: ['$valueKind', 'service'] }, '$fee', 0] } },
                cancellationValue: {
                  $sum: { $cond: [{ $eq: ['$valueKind', 'cancellation'] }, '$fee', 0] },
                },
              },
            },
          ],
          rows: [
            { $match: detailMatch },
            {
              $sort:
                view === 'agreed'
                  ? { valueAt: -1, _id: -1 }
                  : view === 'due'
                    ? { due: -1, _id: -1 }
                    : { refundDue: -1, _id: -1 },
            },
            ...detailPage,
          ],
          count: [{ $match: detailMatch }, { $count: 'total' }],
        },
      },
    ];
    const [[cash], [business]] = await Promise.all([
      Transaction.aggregate(cashStages).option({ maxTimeMS: 15000 }),
      BookingWorkflow.aggregate(businessStages).option({ maxTimeMS: 15000 }),
    ]);
    const details = view === 'cash' ? cash : business;
    sendResponse(
      res,
      200,
      true,
      'OK',
      {
        range: { from: range.from, to: range.to, days: range.days },
        generatedAt: new Date(),
        cash: cash.totals,
        snapshot: business.snapshot,
        accepted: business.accepted,
        rows: details.rows,
        view,
        service,
      },
      { page, limit: 20, total: details.count[0]?.total ?? 0 },
    );
  } catch (e) {
    fail(res, e);
  }
}

type InventoryRow = {
  costumeId: string;
  name: string;
  size: string;
  good: number;
  photographyDays: number;
  rentalDays: number;
  peak: number;
  overCapacityDays: number;
  unknownSchedules: number;
  invalidIntervals: number;
  utilization: number | null;
  missingCostume: boolean;
};
export async function getInventoryReport(req: Request, res: Response) {
  try {
    const range = reportRange(req.query.from, req.query.to),
      page = reportPage(req.query.page);
    const q = req.query.q ?? '';
    if (typeof q !== 'string' || q.length > 100)
      throw new WorkflowProblem(400, 'Tên mẫu tìm kiếm không hợp lệ.');
    const costumes = await Costume.find(
      q.trim()
        ? { name: { $regex: q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
        : {},
    )
      .select('name inventory')
      .lean();
    const names = new Map(costumes.map((c) => [String(c._id), c.name]));
    const data = new Map<string, { row: InventoryRow; days: number[] }>();
    const unknown = new Map<string, number>();
    const invalid = new Map<string, number>();
    const validDate = (value: unknown): value is Date =>
      value instanceof Date && Number.isFinite(+value);
    let invalidIntervals = 0,
      overdueOrders = 0;
    const rowFor = (id: string, size: string) => {
      const key = `${id}:${size}`;
      if (!data.has(key))
        data.set(key, {
          row: {
            costumeId: id,
            name: names.get(id) ?? 'Mẫu không còn trong kho',
            size,
            good: 0,
            photographyDays: 0,
            rentalDays: 0,
            peak: 0,
            overCapacityDays: 0,
            unknownSchedules: 0,
            invalidIntervals: 0,
            utilization: null,
            missingCostume: !names.has(id),
          },
          days: Array(range.days).fill(0),
        });
      return data.get(key)!;
    };
    for (const c of costumes)
      for (const item of c.inventory) {
        const entry = rowFor(String(c._id), item.size);
        if (item.condition === 'good') entry.row.good += item.quantity;
      }
    const add = (
      id: string,
      size: string,
      quantity: number,
      receive: unknown,
      returned: unknown,
      service: 'photography' | 'rental',
    ) => {
      if (q.trim() && !names.has(id)) return false;
      if (!validDate(receive) || !validDate(returned)) {
        invalidIntervals++;
        invalid.set(id, (invalid.get(id) ?? 0) + 1);
        rowFor(id, size || 'Chưa rõ size');
        return false;
      }
      const start = vietnamDay(receive as Date),
        end = vietnamDay(returned as Date);
      if (
        !Number.isFinite(+start) ||
        !Number.isFinite(+end) ||
        end < start ||
        !size ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      ) {
        invalidIntervals++;
        invalid.set(id, (invalid.get(id) ?? 0) + 1);
        rowFor(id, size || 'Chưa rõ size');
        return false;
      }
      const first = Math.max(0, (+start - +range.start) / DAY),
        last = Math.min(range.days - 1, (+end - +range.start) / DAY);
      if (last < first) return false;
      const entry = rowFor(id, size);
      entry.row[service === 'photography' ? 'photographyDays' : 'rentalDays'] +=
        quantity * (last - first + 1);
      for (let d = first; d <= last; d++) entry.days[d] += quantity;
      return true;
    };
    // Padded raw bounds accommodate older midnight-UTC storage of calendar dates.
    const bounds = { $lte: new Date(+range.until + DAY) },
      lower = { $gte: new Date(+range.start - DAY) };
    const schedules = Schedule.find({
      status: { $in: ['pending', 'confirmed', 'completed'] },
      ...(q.trim() ? { costumes: { $in: costumes.map((c) => c._id) } } : {}),
      $or: [
        { costumeReservations: { $elemMatch: { receiveDate: bounds, returnDate: lower } } },
        { shootDate: { ...bounds, ...lower } },
      ],
    })
      .select('costumes costumeReservations shootDate')
      .lean()
      .cursor();
    for await (const s of schedules) {
      for (const line of s.costumeReservations ?? [])
        add(
          String(line.costume),
          line.size,
          line.quantity,
          line.receiveDate,
          line.returnDate,
          'photography',
        );
      if (vietnamDay(s.shootDate) >= range.start && vietnamDay(s.shootDate) <= range.end)
        for (const id of s.costumes.map(String))
          if (
            (!q.trim() || names.has(id)) &&
            !(s.costumeReservations ?? []).some((line) => String(line.costume) === id)
          )
            unknown.set(id, (unknown.get(id) ?? 0) + 1);
    }
    const rentals = RentalOrder.find({
      status: { $in: ['confirmed', 'checked_out', 'returned', 'completed'] },
      ...(q.trim() ? { 'quote.lines.costumeId': { $in: costumes.map((c) => c._id) } } : {}),
      'quote.receiveDate': bounds,
      $or: [{ 'quote.returnDate': lower }, { status: 'checked_out' }, { returnedAt: lower }],
    })
      .select('status quote.lines quote.receiveDate quote.returnDate checkedOutAt returnedAt')
      .lean()
      .cursor();
    for await (const order of rentals) {
      const overdue =
        order.status === 'checked_out' &&
        validDate(order.quote?.returnDate) &&
        vietnamDay(order.quote?.returnDate as Date) < vietnamDay(new Date());
      const historical = ['returned', 'completed'].includes(order.status);
      let overlaps = false;
      for (const line of order.quote?.lines ?? []) {
        const included = add(
          String(line.costumeId),
          line.size!,
          line.quantity!,
          historical ? order.checkedOutAt : order.quote?.receiveDate,
          historical ? order.returnedAt : overdue ? range.end : order.quote?.returnDate,
          'rental',
        );
        overlaps = overlaps || included;
      }
      if (overdue && overlaps) overdueOrders++;
    }
    for (const [id] of unknown)
      if (![...data.values()].some((entry) => entry.row.costumeId === id))
        rowFor(id, 'Chưa rõ size');
    const rows = [...data.values()]
      .map(({ row, days }) => {
        row.unknownSchedules = unknown.get(row.costumeId) ?? 0;
        row.invalidIntervals = invalid.get(row.costumeId) ?? 0;
        row.peak = Math.max(...days);
        row.overCapacityDays = days.filter((count) => count > row.good).length;
        row.utilization =
          row.good > 0 && !row.unknownSchedules && !row.invalidIntervals && !row.missingCostume
            ? ((row.photographyDays + row.rentalDays) / (row.good * range.days)) * 100
            : null;
        return row;
      })
      .sort(
        (a, b) =>
          b.overCapacityDays - a.overCapacityDays ||
          b.peak - a.peak ||
          a.name.localeCompare(b.name, 'vi') ||
          a.size.localeCompare(b.size),
      );
    sendResponse(
      res,
      200,
      true,
      'OK',
      {
        range: { from: range.from, to: range.to, days: range.days },
        generatedAt: new Date(),
        summary: {
          good: rows.reduce((sum, r) => sum + r.good, 0),
          photographyDays: rows.reduce((sum, r) => sum + r.photographyDays, 0),
          rentalDays: rows.reduce((sum, r) => sum + r.rentalDays, 0),
          conflictRows: rows.filter((r) => r.overCapacityDays > 0).length,
          unknownSchedules: [...unknown.values()].reduce((sum, n) => sum + n, 0),
          missingCostumes: new Set(rows.filter((r) => r.missingCostume).map((r) => r.costumeId))
            .size,
          invalidIntervals,
          overdueOrders,
        },
        rows: rows.slice((page - 1) * 20, page * 20),
      },
      { page, limit: 20, total: rows.length },
    );
  } catch (e) {
    fail(res, e);
  }
}
