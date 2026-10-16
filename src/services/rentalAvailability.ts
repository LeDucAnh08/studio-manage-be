import { ClientSession, Types } from 'mongoose';
import Costume from '../models/Costume';
import Schedule from '../models/Schedule';
import RentalOrder from '../models/RentalOrder';
import { vietnamDay } from '../utils/rentalPeriod';
import { WorkflowProblem } from './workflowTransactions';

export { vietnamDay } from '../utils/rentalPeriod';

const HOLD_STATUSES = ['confirmed', 'checked_out'];
const SCHEDULE_STATUSES = ['pending', 'confirmed', 'completed'];

export const rentalReservations = async (
  costumeId: string,
  session?: ClientSession,
  exclude?: string,
) => {
  const query = RentalOrder.find({
    status: { $in: HOLD_STATUSES },
    'quote.lines.costumeId': costumeId,
    ...(exclude ? { _id: { $ne: exclude } } : {}),
  });
  if (session) query.session(session);
  return query.lean();
};

export const loadRentalHolds = async (
  costumeIds: string[],
  session?: ClientSession,
  exclude?: string,
): Promise<{ orders: any[]; schedules: any[] }> => {
  if (!costumeIds.length) return { orders: [], schedules: [] };
  const orders = RentalOrder.find({
    status: { $in: HOLD_STATUSES },
    'quote.lines.costumeId': { $in: costumeIds },
    ...(exclude ? { _id: { $ne: exclude } } : {}),
  }).select('status quote.lines quote.receiveDate quote.returnDate');
  const schedules = Schedule.find({
    $or: [
      { costumes: { $in: costumeIds } },
      { 'costumeReservations.costume': { $in: costumeIds } },
    ],
    status: { $in: SCHEDULE_STATUSES },
  }).select('status costumes costumeReservations shootDate');
  if (session) {
    orders.session(session);
    schedules.session(session);
  }
  // Sequential execution also works inside MongoDB transactions.
  return { orders: await orders.lean(), schedules: await schedules.lean() };
};

export const rentalUsed = (
  orders: any[],
  costumeId: string,
  size: string,
  date: Date,
  today = vietnamDay(new Date()),
): number =>
  orders.reduce((sum, order) => {
    if (!HOLD_STATUSES.includes(order.status) || !order.quote) return sum;
    const start = vietnamDay(order.quote.receiveDate);
    const end = vietnamDay(order.quote.returnDate);
    // Checked-out garments remain unavailable until staff records their actual return.
    const overdue = order.status === 'checked_out' && end < today;
    if (date < start || (!overdue && date > end)) return sum;
    return (
      sum +
      order.quote.lines
        .filter((row: any) => String(row.costumeId) === costumeId && row.size === size)
        .reduce((count: number, row: any) => count + row.quantity, 0)
    );
  }, 0);

export const rentalUsageOnDay = (
  orders: any[],
  schedules: any[],
  costumeId: string,
  size: string,
  date: Date,
  today = vietnamDay(new Date()),
): { quantity: number; unreconciled: boolean } => {
  let quantity = rentalUsed(orders, costumeId, size, date, today);
  let unreconciled = false;
  for (const schedule of schedules) {
    if (!SCHEDULE_STATUSES.includes(schedule.status)) continue;
    const matching = (schedule.costumeReservations ?? []).filter(
      (row: any) => String(row.costume) === costumeId,
    );
    if (
      !matching.length &&
      (schedule.costumes ?? []).some((id: any) => String(id) === costumeId) &&
      vietnamDay(schedule.shootDate).getTime() === date.getTime()
    )
      unreconciled = true;
    quantity += matching
      .filter(
        (row: any) =>
          row.size === size &&
          vietnamDay(row.receiveDate) <= date &&
          vietnamDay(row.returnDate) >= date,
      )
      .reduce((sum: number, row: any) => sum + row.quantity, 0);
  }
  return { quantity, unreconciled };
};

const goodQuantity = (inventory: any[], size: string): number =>
  inventory
    .filter((row) => row.size === size && row.condition === 'good')
    .reduce((sum, row) => sum + row.quantity, 0);

export const getRentalAvailability = (
  costume: { _id: unknown; inventory?: any[] },
  period: { receiveDate: Date; returnDate: Date },
  orders: any[],
  schedules: any[],
  today = vietnamDay(new Date()),
): Record<string, number> => {
  const available: Record<string, number> = {};
  const inventory = costume.inventory ?? [];
  for (const size of new Set(inventory.map((row) => row.size as string))) {
    const good = goodQuantity(inventory, size);
    let remaining = good;
    for (
      let t = vietnamDay(period.receiveDate).getTime();
      remaining > 0 && t <= vietnamDay(period.returnDate).getTime();
      t += 86400000
    ) {
      const usage = rentalUsageOnDay(
        orders,
        schedules,
        String(costume._id),
        size,
        new Date(t),
        today,
      );
      remaining = Math.min(remaining, usage.unreconciled ? 0 : Math.max(0, good - usage.quantity));
    }
    if (remaining > 0) available[size] = remaining;
  }
  return available;
};

export const ensureRentalAvailability = async (
  quote: any,
  session: ClientSession,
  exclude?: string,
): Promise<void> => {
  const ids = [...new Set<string>(quote.lines.map((line: any) => String(line.costumeId)))];
  const costumes = await Costume.find({ _id: { $in: ids } })
    .session(session)
    .lean();
  const { orders, schedules } = await loadRentalHolds(ids, session, exclude);
  const requested = new Map<string, { line: any; quantity: number }>();
  for (const line of quote.lines) {
    const key = `${line.costumeId}:${line.size}`;
    requested.set(key, { line, quantity: (requested.get(key)?.quantity ?? 0) + line.quantity });
  }
  const today = vietnamDay(new Date());
  for (const { line, quantity } of requested.values()) {
    const id = String(line.costumeId);
    const costume = costumes.find((item) => String(item._id) === id);
    if (!costume || !costume.isRentalItem)
      throw new WorkflowProblem(409, 'Mẫu này không còn được phép cho thuê.');
    const available = getRentalAvailability(costume, quote, orders, schedules, today);
    if ((available[line.size] ?? 0) < quantity)
      throw new WorkflowProblem(409, `Không đủ mẫu ${line.name}, cỡ ${line.size} trong kỳ thuê.`);
  }
};

export const ensureRentalStockPreserved = async (
  id: Types.ObjectId,
  inventory: any[],
  session: ClientSession,
): Promise<void> => {
  const { orders, schedules } = await loadRentalHolds([String(id)], session);
  const today = vietnamDay(new Date());
  const days = new Set<number>([today.getTime()]);
  const sizes = new Set<string>();
  for (const order of orders) {
    days.add(vietnamDay(order.quote.receiveDate).getTime());
    days.add(vietnamDay(order.quote.returnDate).getTime());
    for (const line of order.quote.lines)
      if (String(line.costumeId) === String(id)) sizes.add(line.size);
  }
  for (const schedule of schedules)
    for (const row of schedule.costumeReservations ?? []) {
      if (String(row.costume) !== String(id)) continue;
      days.add(vietnamDay(row.receiveDate).getTime());
      days.add(vietnamDay(row.returnDate).getTime());
      sizes.add(row.size);
    }
  for (const size of sizes)
    for (const t of days) {
      if (t < today.getTime()) continue;
      const used = rentalUsageOnDay(
        orders,
        schedules,
        String(id),
        size,
        new Date(t),
        today,
      ).quantity;
      if (goodQuantity(inventory, size) < used)
        throw new WorkflowProblem(
          409,
          `Cỡ ${size} đang được đơn thuê/lịch chụp giữ; không thể giảm tồn.`,
        );
    }
};
