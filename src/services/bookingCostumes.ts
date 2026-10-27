import { isValidObjectId, type ClientSession } from 'mongoose';
import Booking from '../models/Booking';
import BookingWorkflow from '../models/BookingWorkflow';
import Costume from '../models/Costume';
import CostumeType from '../models/CostumeType';
import { getRentalAvailability, loadRentalHolds } from './rentalAvailability';
import { withResourceTransaction, WorkflowProblem } from './workflowTransactions';
import { vietnamDay } from '../utils/rentalPeriod';

export interface CostumeSelectionInput {
  costumeId: string;
  size: string;
  quantity: number;
}

export const parseCostumeSelections = (value: unknown): CostumeSelectionInput[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new WorkflowProblem(400, 'Chọn tối đa 100 dòng trang phục.');
  const seen = new Set<string>();
  return value
    .map((row: any) => {
      if (
        !row ||
        typeof row.costumeId !== 'string' ||
        !/^[a-f\d]{24}$/i.test(row.costumeId) ||
        typeof row.size !== 'string' ||
        !row.size.trim() ||
        row.size.length > 12 ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity < 1 ||
        row.quantity > 1000
      )
        throw new WorkflowProblem(400, 'Mẫu, size hoặc số lượng trang phục không hợp lệ.');
      const costumeId = row.costumeId.toLowerCase();
      const size = row.size.trim();
      const key = `${costumeId}:${size}`;
      if (seen.has(key)) throw new WorkflowProblem(400, 'Mỗi mẫu và size chỉ được chọn một lần.');
      seen.add(key);
      return { costumeId, size, quantity: row.quantity };
    })
    .sort((a, b) => a.costumeId.localeCompare(b.costumeId) || a.size.localeCompare(b.size));
};

export const validateBookingCostumes = async (
  selections: CostumeSelectionInput[],
  allowedTypes: unknown[],
  members: number,
  period: { receiveDate: Date; returnDate: Date },
  session: ClientSession,
  excludeBooking?: string,
) => {
  const ids = [...new Set(selections.map((row) => row.costumeId))];
  const costumes = await Costume.find({
    _id: { $in: ids },
    type: { $in: allowedTypes },
    itemKind: 'clothing',
  })
    .session(session)
    .lean();
  if (costumes.length !== ids.length)
    throw new WorkflowProblem(400, 'Một mẫu không còn thuộc gói chụp hoặc không phải quần áo.');
  const types = await CostumeType.find({ _id: { $in: allowedTypes } })
    .session(session)
    .lean();
  const { orders, schedules } = await loadRentalHolds(ids, session);
  // Remove only this booking's hold; other bookings and all rental orders remain counted.
  const otherOrders = excludeBooking
    ? orders.filter((order) => String(order.bookingId ?? '') !== excludeBooking)
    : orders;
  const totals = new Map<string, number>();
  const conflicts: Array<{ costumeId: string; name: string; size: string; available: number }> = [];
  const snapshots = selections.map((row) => {
    const costume = costumes.find((item) => String(item._id) === row.costumeId)!;
    const typeId = String(costume.type);
    const type = types.find((item) => String(item._id) === typeId);
    if (!type) throw new WorkflowProblem(400, 'Loại trang phục không còn tồn tại.');
    if (!(costume.inventory ?? []).some((item) => item.size === row.size))
      throw new WorkflowProblem(400, `Size ${row.size} không hợp lệ cho ${costume.name}.`);
    totals.set(typeId, (totals.get(typeId) ?? 0) + row.quantity);
    if (totals.get(typeId)! > members)
      throw new WorkflowProblem(
        400,
        `Tổng ${type.name} không được vượt quá ${members} thành viên.`,
      );
    const available = getRentalAvailability(costume, period, otherOrders, schedules)[row.size] ?? 0;
    if (available < row.quantity)
      conflicts.push({ costumeId: row.costumeId, name: costume.name, size: row.size, available });
    return { ...row, name: costume.name, typeId, typeName: type.name };
  });
  if (conflicts.length)
    throw Object.assign(
      new WorkflowProblem(
        409,
        `Không đủ trang phục: ${conflicts.map((row) => `${row.name}, size ${row.size} (còn ${row.available})`).join('; ')}.`,
      ),
      { costumeConflicts: conflicts },
    );
  return snapshots;
};

export const createBookingWithCostumes = (payload: any, selections: CostumeSelectionInput[]) =>
  withResourceTransaction(async (session) => {
    if (payload.clientRequestId) {
      const existing = await Booking.findOne({
        client: payload.client,
        clientRequestId: payload.clientRequestId,
      })
        .select('+requestFingerprint')
        .session(session);
      if (existing) {
        if (existing.requestFingerprint !== payload.requestFingerprint)
          throw new WorkflowProblem(409, 'Mã gửi yêu cầu đã được dùng cho nội dung khác');
        return { _id: existing._id, created: false };
      }
    }
    const period = {
      receiveDate: vietnamDay(payload.startAt),
      returnDate: vietnamDay(payload.endAt),
    };
    const snapshots = await validateBookingCostumes(
      selections,
      payload.packageSnapshot.costumeIds,
      payload.members,
      period,
      session,
    );
    const [booking] = await Booking.create(
      [
        {
          ...payload,
          costumeSelections: snapshots,
          costumeHold: {
            ...period,
            status: 'temporary',
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        },
      ],
      { session },
    );
    return { _id: booking._id, created: true };
  });

export const reviewBookingWithCostumes = (
  id: string,
  status: 'approved' | 'rejected',
  note: string,
  actor: unknown,
) =>
  withResourceTransaction(async (session) => {
    const booking = await Booking.findById(id).session(session);
    if (!booking || booking.status !== 'pending' || booking.startAt <= new Date())
      throw new WorkflowProblem(409, 'Yêu cầu đã được xử lý hoặc thời gian mong muốn đã qua.');
    if (booking.costumeHold && booking.costumeHold.status !== 'released') {
      if (status === 'approved') {
        await validateBookingCostumes(
          parseCostumeSelections(
            booking.costumeSelections.map((row) => ({
              costumeId: String(row.costumeId),
              size: row.size,
              quantity: row.quantity,
            })),
          ),
          booking.packageSnapshot.costumeIds,
          booking.members,
          booking.costumeHold,
          session,
          String(booking._id),
        );
        booking.costumeHold.status = 'approved';
        booking.costumeHold.expiresAt = undefined;
      } else {
        booking.costumeHold.status = 'released';
        booking.costumeHold.releasedAt = new Date();
        booking.costumeHold.releaseReason = note;
      }
    }
    booking.status = status;
    booking.reviewNote = note;
    booking.reviewedBy = actor as any;
    booking.reviewedAt = new Date();
    const message = `${status === 'approved' ? 'Studio đã duyệt yêu cầu; lịch chính thức sẽ được liên hệ xác nhận.' : 'Studio đã từ chối yêu cầu.'} ${note}`;
    booking.events.push({ audience: 'client', message }, { audience: 'admin', message });
    await booking.save({ session });
    return booking;
  });

export const releaseBookingCostumes = (id: string, note: string) =>
  withResourceTransaction(async (session) => {
    if (!isValidObjectId(id)) throw new WorkflowProblem(404, 'Không tìm thấy booking');
    const booking = await Booking.findById(id).session(session);
    const workflow = await BookingWorkflow.findOne({ booking: id }).session(session);
    if (
      !booking?.costumeHold ||
      booking.costumeHold.status === 'transferred' ||
      workflow?.resources.schedule
    )
      throw new WorkflowProblem(409, 'Chỉ bỏ giữ trang phục trước khi có lịch chính thức.');
    if (booking.costumeHold.status === 'released') return booking;
    booking.costumeHold.status = 'released';
    booking.costumeHold.releasedAt = new Date();
    booking.costumeHold.releaseReason = note;
    const message = `Studio đã bỏ giữ trang phục: ${note}`;
    booking.events.push({ audience: 'client', message }, { audience: 'admin', message });
    await booking.save({ session });
    return booking;
  });
