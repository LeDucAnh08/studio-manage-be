import { ClientSession, Types, isValidObjectId } from 'mongoose';
import Schedule from '../models/Schedule';
import User from '../models/User';
import PhotographerUnavailability from '../models/PhotographerUnavailability';
import BookingWorkflow from '../models/BookingWorkflow';
import { WorkflowProblem } from './workflowTransactions';

export const PHOTOGRAPHER_BUFFER_MS = 60 * 60 * 1000;
const DAY = 86400000;
export const vietnamDay = (value: Date | string): number => {
  const shifted = new Date(new Date(value).getTime() + 7 * 3600000);
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 7 * 3600000
  );
};
const minutes = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};
export const scheduleInterval = (schedule: {
  shootDate: Date | string;
  startTime?: string;
  endTime?: string;
}): { start: number; end: number } | null => {
  const day = vietnamDay(schedule.shootDate);
  const start = minutes(schedule.startTime);
  const end = minutes(schedule.endTime);
  if (!Number.isFinite(day) || start === null || end === null || end <= start) return null;
  return { start: day + start * 60000, end: day + end * 60000 };
};
export const parsePhotographerInterval = (startAt: unknown, endAt: unknown) => {
  // API timestamps must include their timezone, rather than depend on the host TZ.
  const timestamp = (value: unknown) =>
    typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      ? new Date(value).getTime()
      : NaN;
  const start = timestamp(startAt);
  const end = timestamp(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new WorkflowProblem(400, 'Khoảng thời gian không hợp lệ; cần ngày giờ kèm múi giờ.');
  return { start, end };
};
export const intervalsConflict = (
  requested: { start: number; end: number },
  existing: { start: number; end: number },
  buffer = 0,
) => requested.start < existing.end + buffer && existing.start < requested.end + buffer;

export interface PhotographerAvailability {
  _id: string;
  name: string;
  status: 'available' | 'busy' | 'unknown';
  conflicts: string[];
  schedules: Array<{
    _id: string;
    shootDate: Date;
    startTime?: string;
    endTime?: string;
    location?: string;
    conflicting: boolean;
  }>;
}

export const photographerAvailability = async (
  interval: { start: number; end: number },
  options: {
    photographerIds?: string[];
    excludeSchedule?: Types.ObjectId;
    excludeBooking?: Types.ObjectId;
    session?: ClientSession;
  } = {},
): Promise<PhotographerAvailability[]> => {
  const { session, photographerIds, excludeSchedule, excludeBooking } = options;
  const users = await User.find({
    isActive: true,
    roles: 3,
    ...(photographerIds ? { _id: { $in: photographerIds } } : {}),
  })
    .select('_id name username')
    .session(session ?? null)
    .lean();
  const ids = users.map((user) => user._id);
  const firstDay = vietnamDay(new Date(interval.start));
  const lastDay = vietnamDay(new Date(interval.end - 1));
  const schedules = await Schedule.find({
    status: { $in: ['pending', 'confirmed'] },
    // Include adjacent days for the 60-minute buffer, and both legacy date encodings.
    shootDate: { $gte: new Date(firstDay - DAY), $lt: new Date(lastDay + 2 * DAY) },
    $or: [{ leadPhotographer: { $in: ids } }, { supportPhotographers: { $in: ids } }],
    ...(excludeSchedule ? { _id: { $ne: excludeSchedule } } : {}),
  })
    .select('_id shootDate startTime endTime location leadPhotographer supportPhotographers')
    .session(session ?? null)
    .lean();
  const blocks = await PhotographerUnavailability.find({
    photographer: { $in: ids },
    startAt: { $lt: new Date(interval.end) },
    endAt: { $gt: new Date(interval.start) },
  })
    .select('photographer startAt endAt')
    .session(session ?? null)
    .lean();
  const holds = await BookingWorkflow.find({
    'packageReservation.status': 'held',
    'packageReservation.expiresAt': { $gt: new Date() },
    'packageReservation.photographers': { $in: ids },
    ...(excludeBooking ? { booking: { $ne: excludeBooking } } : {}),
  })
    .select('quote.proposedSchedule packageReservation.photographers')
    .session(session ?? null)
    .lean();
  return users
    .map((user) => {
      const conflicts: string[] = [];
      let unknown = false;
      const ownSchedules = schedules
        .filter((row) =>
          [row.leadPhotographer, ...row.supportPhotographers].some(
            (id) => String(id) === String(user._id),
          ),
        )
        .flatMap((row) => {
          const existing = scheduleInterval(row);
          const day = vietnamDay(row.shootDate);
          if (
            day < firstDay &&
            (!existing || existing.end + PHOTOGRAPHER_BUFFER_MS <= interval.start)
          )
            return [];
          if (
            day > lastDay &&
            (!existing || existing.start >= interval.end + PHOTOGRAPHER_BUFFER_MS)
          )
            return [];
          const conflicting = existing
            ? intervalsConflict(interval, existing, PHOTOGRAPHER_BUFFER_MS)
            : intervalsConflict(interval, { start: day, end: day + DAY });
          if (conflicting) {
            if (!existing) {
              unknown = true;
              conflicts.push('Lịch cũ chưa có khung giờ hợp lệ; cần đối soát.');
            } else {
              conflicts.push(
                `Lịch ${row.startTime}–${row.endTime}: trùng giờ hoặc chưa đủ 60 phút giữa hai buổi chụp.`,
              );
            }
          }
          return [
            {
              _id: String(row._id),
              shootDate: row.shootDate,
              startTime: row.startTime,
              endTime: row.endTime,
              location: row.location,
              conflicting,
            },
          ];
        });
      if (blocks.some((row) => String(row.photographer) === String(user._id)))
        conflicts.push('Có lịch bận riêng trong khoảng thời gian này.');
      for (const hold of holds) {
        const held = hold.packageReservation?.photographers.some(
          (id: Types.ObjectId) => String(id) === String(user._id),
        );
        const range = hold.quote?.proposedSchedule
          ? scheduleInterval(hold.quote.proposedSchedule as any)
          : null;
        if (held && range && intervalsConflict(interval, range, PHOTOGRAPHER_BUFFER_MS))
          conflicts.push('Đang giữ lịch tạm cho một đơn chờ đặt cọc.');
      }
      return {
        _id: String(user._id),
        name: user.name || user.username,
        status: unknown
          ? ('unknown' as const)
          : conflicts.length
            ? ('busy' as const)
            : ('available' as const),
        conflicts,
        schedules: ownSchedules.sort(
          (a, b) =>
            a.shootDate.getTime() - b.shootDate.getTime() ||
            (a.startTime ?? '').localeCompare(b.startTime ?? ''),
        ),
      };
    })
    .sort(
      (a, b) =>
        Number(a.status !== 'available') - Number(b.status !== 'available') ||
        a.name.localeCompare(b.name),
    );
};

export const ensurePhotographersAvailable = async (
  photographerIds: string[],
  interval: { start: number; end: number },
  session: ClientSession,
  excludeSchedule?: Types.ObjectId,
  excludeBooking?: Types.ObjectId,
) => {
  if (
    !photographerIds.length ||
    photographerIds.some((id) => !isValidObjectId(id)) ||
    new Set(photographerIds).size !== photographerIds.length
  )
    throw new WorkflowProblem(400, 'Danh sách thợ chụp không hợp lệ hoặc bị trùng.');
  const rows = await photographerAvailability(interval, {
    photographerIds,
    session,
    excludeSchedule,
    excludeBooking,
  });
  if (rows.length !== photographerIds.length)
    throw new WorkflowProblem(400, 'Mỗi thợ được phân công phải là nhân viên đang hoạt động.');
  const unavailable = rows.find((row) => row.status !== 'available');
  if (unavailable)
    throw new WorkflowProblem(409, `${unavailable.name}: ${unavailable.conflicts.join(' ')}`);
};
