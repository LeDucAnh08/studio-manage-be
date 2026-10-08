import { ClientSession, Types } from 'mongoose';
import Costume from '../models/Costume';
import Schedule from '../models/Schedule';
import RentalOrder from '../models/RentalOrder';
import { WorkflowProblem } from './workflowTransactions';

export const vietnamDay = (value: Date | string): Date => {
  const time = new Date(value).getTime();
  return new Date(Math.floor((time + 25200000) / 86400000) * 86400000 - 25200000);
};
export const rentalReservations = async (
  costumeId: string,
  session: ClientSession,
  exclude?: string,
) =>
  RentalOrder.find({
    status: { $in: ['confirmed', 'checked_out'] },
    'quote.lines.costumeId': costumeId,
    ...(exclude ? { _id: { $ne: exclude } } : {}),
  })
    .session(session)
    .lean();

export const rentalUsed = (orders: any[], costumeId: string, size: string, date: Date): number =>
  orders.reduce((sum, order) => {
    const start = vietnamDay(order.quote.receiveDate);
    const end = vietnamDay(order.quote.returnDate);
    // An overdue checked-out order still holds its garments until staff records a return.
    const overdue = order.status === 'checked_out' && end < vietnamDay(new Date());
    if (date < start || (!overdue && date > end)) return sum;
    return (
      sum +
      order.quote.lines
        .filter((row: any) => String(row.costumeId) === costumeId && row.size === size)
        .reduce((count: number, row: any) => count + row.quantity, 0)
    );
  }, 0);

export const ensureRentalAvailability = async (
  quote: any,
  session: ClientSession,
  exclude?: string,
): Promise<void> => {
  for (const line of quote.lines) {
    const id = String(line.costumeId);
    const costume = await Costume.findById(id).session(session).lean();
    if (!costume || !costume.isRentalItem)
      throw new WorkflowProblem(409, 'Mẫu này không còn được phép cho thuê.');
    const good = costume.inventory
      .filter((row) => row.size === line.size && row.condition === 'good')
      .reduce((sum, row) => sum + row.quantity, 0);
    const rentals = await rentalReservations(id, session, exclude);
    const schedules = await Schedule.find({
      costumes: id,
      status: { $in: ['pending', 'confirmed', 'completed'] },
    })
      .session(session)
      .lean();
    for (
      let t = vietnamDay(quote.receiveDate).getTime();
      t <= vietnamDay(quote.returnDate).getTime();
      t += 86400000
    ) {
      const day = new Date(t);
      let used = rentalUsed(rentals, id, line.size, day);
      for (const schedule of schedules) {
        const matching = (schedule.costumeReservations ?? []).filter(
          (row) => String(row.costume) === id,
        );
        if (!matching.length && vietnamDay(schedule.shootDate).getTime() === t)
          throw new WorkflowProblem(409, 'Lịch chụp cũ chưa đối soát kích cỡ của mẫu này.');
        used += matching
          .filter(
            (row) =>
              row.size === line.size &&
              vietnamDay(row.receiveDate) <= day &&
              vietnamDay(row.returnDate) >= day,
          )
          .reduce((sum, row) => sum + row.quantity, 0);
      }
      if (used + line.quantity > good)
        throw new WorkflowProblem(409, `Không đủ mẫu ${line.name}, cỡ ${line.size} trong kỳ thuê.`);
    }
  }
};

export const ensureRentalStockPreserved = async (
  id: Types.ObjectId,
  inventory: any[],
  session: ClientSession,
): Promise<void> => {
  const orders = await rentalReservations(String(id), session);
  const days = new Set<number>([vietnamDay(new Date()).getTime()]);
  for (const order of orders) {
    days.add(vietnamDay(order.quote!.receiveDate!).getTime());
    days.add(vietnamDay(order.quote!.returnDate!).getTime());
  }
  const schedules = await Schedule.find({
    costumes: id,
    status: { $in: ['pending', 'confirmed', 'completed'] },
  })
    .session(session)
    .lean();
  for (const schedule of schedules)
    for (const row of schedule.costumeReservations ?? []) {
      days.add(vietnamDay(row.receiveDate).getTime());
      days.add(vietnamDay(row.returnDate).getTime());
    }
  const sizes = new Set(
    orders.flatMap((order) =>
      order
        .quote!.lines.filter((line) => String(line.costumeId) === String(id))
        .map((line) => line.size),
    ),
  );
  for (const size of sizes)
    for (const t of days) {
      if (t < vietnamDay(new Date()).getTime()) continue;
      const day = new Date(t);
      let used = rentalUsed(orders, String(id), size!, day);
      for (const schedule of schedules) {
        const rows = (schedule.costumeReservations ?? []).filter(
          (row) => String(row.costume) === String(id),
        );
        used += rows
          .filter(
            (row) =>
              row.size === size &&
              vietnamDay(row.receiveDate) <= day &&
              vietnamDay(row.returnDate) >= day,
          )
          .reduce((sum, row) => sum + row.quantity, 0);
      }
      const good = inventory
        .filter((row) => row.size === size && row.condition === 'good')
        .reduce((sum, row) => sum + row.quantity, 0);
      if (good < used)
        throw new WorkflowProblem(
          409,
          `Cỡ ${size} đang được đơn thuê/lịch chụp giữ; không thể giảm tồn.`,
        );
    }
};
