import BookingWorkflow, { type IBookingWorkflow } from '../models/BookingWorkflow';
import { selectAcceptedContractQuote, acceptedContractTerms } from '../utils/workflowContract';
import { Request, Response } from 'express';
import PDFDocument from 'pdfkit';
import path from 'path';
import Schedule from '../models/Schedule';
import Customer from '../models/Customer';
import type { ICustomer } from '../models/Customer';
import type { IUser } from '../models/User';
import type { ISeason } from '../models/Season';
import type { ScheduleResponse } from '../types/dto';
import { notifyUsers } from '../services/telegramService';
import { createFolderAndLog, deleteFolderAndRow } from '../services/googleSheetService';
import { resolveSeasonForDate } from '../utils/seasonCache';
import { sendResponse } from '../utils/response';
import Costume from '../models/Costume';
import { ClientSession, Types } from 'mongoose';
import { withResourceTransaction, WorkflowProblem } from '../services/workflowTransactions';
import { workflowEnabled } from '../services/workflowTransactions';

interface ScheduleQuery {
  customer?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: string;
  limit?: string;
  season?: string;
}

const buildFilter = (q: ScheduleQuery) => {
  const filter: Record<string, unknown> = {};
  if (q.customer) filter.customer = q.customer;
  if (q.status) filter.status = q.status;
  if (q.dateFrom || q.dateTo) {
    const dateRange: Record<string, Date> = {};
    if (q.dateFrom) dateRange.$gte = new Date(q.dateFrom);
    if (q.dateTo) dateRange.$lte = new Date(q.dateTo);
    filter.shootDate = dateRange;
  }
  return filter;
};

const FONT_REGULAR = path.join(__dirname, '../../src/assets/fonts/Roboto-Regular.ttf');
const FONT_BOLD = path.join(__dirname, '../../src/assets/fonts/Roboto-Bold.ttf');

const vietnamDay = (value: Date | string): Date => {
  const shifted = new Date(new Date(value).getTime() + 7 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
      7 * 60 * 60 * 1000,
  );
};
const clockMinutes = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter(Types.ObjectId.isValid).map(String) : [];

const ensureScheduleResourcesAvailable = async (
  proposed: any,
  session: ClientSession,
  excludeId?: Types.ObjectId,
): Promise<void> => {
  if (proposed.status === 'cancelled') return;
  const shootDate = vietnamDay(proposed.shootDate);
  if (!Number.isFinite(shootDate.getTime()))
    throw new WorkflowProblem(400, 'Ngày chụp không hợp lệ');
  const start = clockMinutes(proposed.startTime);
  const end = clockMinutes(proposed.endTime);
  const photographerIds = [
    ...new Set(
      [proposed.leadPhotographer, ...(proposed.supportPhotographers ?? [])]
        .filter(Boolean)
        .map(String),
    ),
  ];
  if (photographerIds.length && (start === null || end === null || end <= start)) {
    throw new WorkflowProblem(409, 'Lịch có thợ chụp cần khung giờ hợp lệ để kiểm tra xung đột');
  }
  if (photographerIds.length && ['pending', 'confirmed'].includes(proposed.status ?? 'pending')) {
    const schedules = await Schedule.find({
      status: { $in: ['pending', 'confirmed'] },
      shootDate: {
        $gte: new Date(shootDate.getTime() - 7 * 60 * 60 * 1000),
        $lt: new Date(shootDate.getTime() + 86400000 + 7 * 60 * 60 * 1000),
      },
      $or: [
        { leadPhotographer: { $in: photographerIds } },
        { supportPhotographers: { $in: photographerIds } },
      ],
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
      .session(session)
      .lean();
    for (const existing of schedules) {
      if (vietnamDay(existing.shootDate).getTime() !== shootDate.getTime()) continue;
      const oldStart = clockMinutes(existing.startTime);
      const oldEnd = clockMinutes(existing.endTime);
      if (oldStart === null || oldEnd === null)
        throw new WorkflowProblem(
          409,
          'Lịch cũ chưa có khung giờ; hãy đối soát lịch đó trước khi phân công thợ chụp',
        );
      if (start! < oldEnd && oldStart < end!)
        throw new WorkflowProblem(409, 'Thợ chụp đã có lịch bị trùng giờ');
    }
  }

  const costumeIds = [...new Set(ids(proposed.costumes))];
  const reservations = Array.isArray(proposed.costumeReservations)
    ? proposed.costumeReservations
    : [];
  if (
    reservations.some(
      (item: any) =>
        !Types.ObjectId.isValid(item?.costume) ||
        typeof item.size !== 'string' ||
        !item.size.trim(),
    )
  )
    throw new WorkflowProblem(400, 'Mã trang phục hoặc kích cỡ không hợp lệ');
  const entries = reservations.length
    ? reservations.map((item: any) => ({
        costumeId: String(item.costume),
        size: String(item.size),
        quantity: Number(item.quantity),
        receiveDate: vietnamDay(item.receiveDate),
        returnDate: vietnamDay(item.returnDate),
      }))
    : costumeIds.map((costumeId) => ({
        costumeId,
        size: null as string | null,
        quantity: 1,
        receiveDate: shootDate,
        returnDate: shootDate,
      }));
  if (
    reservations.length &&
    (new Set(entries.map((entry: any) => entry.costumeId)).size !== costumeIds.length ||
      costumeIds.some((id) => !entries.some((entry: any) => entry.costumeId === id)))
  ) {
    throw new WorkflowProblem(400, 'Lịch cần khai báo kích cỡ cho toàn bộ trang phục đã chọn');
  }
  const reservationKeys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.costumeId}:${entry.size ?? '*'}`;
    if (reservationKeys.has(key))
      throw new WorkflowProblem(400, 'Mỗi trang phục và kích cỡ chỉ được khai báo một lần');
    reservationKeys.add(key);
    if (entry.receiveDate > shootDate || entry.returnDate < shootDate)
      throw new WorkflowProblem(400, 'Ngày nhận và trả trang phục phải bao gồm ngày chụp');
  }
  for (const entry of entries) {
    if (!costumeIds.includes(entry.costumeId))
      throw new WorkflowProblem(
        400,
        'Các lượt giữ trang phục phải khớp danh sách trang phục của lịch',
      );
    if (
      !Number.isSafeInteger(entry.quantity) ||
      entry.quantity < 1 ||
      !Number.isFinite(entry.receiveDate.getTime()) ||
      !Number.isFinite(entry.returnDate.getTime()) ||
      entry.receiveDate > entry.returnDate ||
      entry.returnDate.getTime() - entry.receiveDate.getTime() > 365 * 86400000
    ) {
      throw new WorkflowProblem(
        400,
        'Khoảng ngày, kích cỡ hoặc số lượng giữ trang phục không hợp lệ',
      );
    }
    const costume = await Costume.findById(entry.costumeId).session(session).lean();
    if (!costume) throw new WorkflowProblem(409, 'Một trang phục đã bị xóa hoặc không còn tồn tại');
    const sizes = entry.size
      ? [entry.size]
      : (costume.inventory ?? [])
          .filter((row: any) => row.condition === 'good' && row.quantity > 0)
          .map((row: any) => row.size);
    for (const size of sizes) {
      const good = (costume.inventory ?? [])
        .filter((row: any) => row.size === size && row.condition === 'good')
        .reduce((sum: number, row: any) => sum + row.quantity, 0);
      const requested = entry.size ? entry.quantity : good;
      if (entry.size && good < entry.quantity)
        throw new WorkflowProblem(
          409,
          `Không đủ trang phục tình trạng tốt cỡ ${size}: ${costume.name}`,
        );
      const existing = (await Schedule.find({
        status: { $in: ['pending', 'confirmed', 'completed'] },
        costumes: entry.costumeId,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      })
        .session(session)
        .lean()) as any[];
      for (
        let day = entry.receiveDate.getTime();
        day <= entry.returnDate.getTime();
        day += 86400000
      ) {
        const currentDay = new Date(day);
        let used = 0;
        for (const row of existing) {
          const matching = (row.costumeReservations ?? []).filter(
            (item: any) => String(item.costume) === entry.costumeId,
          );
          if (matching.length) {
            if (entry.size)
              used += matching
                .filter(
                  (item: any) =>
                    item.size === size &&
                    vietnamDay(item.receiveDate) <= currentDay &&
                    vietnamDay(item.returnDate) >= currentDay,
                )
                .reduce((sum: number, item: any) => sum + item.quantity, 0);
            else if (
              matching.some(
                (item: any) =>
                  vietnamDay(item.receiveDate) <= currentDay &&
                  vietnamDay(item.returnDate) >= currentDay,
              )
            )
              used = good;
          } else if (vietnamDay(row.shootDate).getTime() === currentDay.getTime()) {
            used = good;
          }
        }
        if (used + requested > good)
          throw new WorkflowProblem(
            409,
            `Không đủ số lượng trang phục còn trống cỡ ${size}: ${costume.name}`,
          );
      }
    }
  }
};

const sendScheduleProblem = (res: Response, error: unknown): void => {
  const problem = error as WorkflowProblem;
  sendResponse(res, problem.status ?? 500, false, problem.message ?? 'Internal server error');
};

export const getAll = async (req: Request, res: Response): Promise<void> => {
  const { page = '1', limit = '20', season, ...rest } = req.query as ScheduleQuery;
  const filter = buildFilter(rest);
  if (season) {
    filter.season = season;
  }
  const skip = (Number(page) - 1) * Number(limit);
  const USER_FIELDS = '_id username name roles isActive createdAt';
  const CUSTOMER_FIELDS =
    '_id className school contactName contactPhone contactAddress total totalMale totalFemale notes createdAt';
  const [data, total] = await Promise.all([
    Schedule.find(filter)
      .populate('customer', CUSTOMER_FIELDS)
      .populate({ path: 'package', populate: { path: 'costumes' } })
      .populate('costumes')
      .populate('leadPhotographer', USER_FIELDS)
      .populate('supportPhotographers', USER_FIELDS)
      .populate('bookedBy', USER_FIELDS)
      .sort({ shootDate: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean<ScheduleResponse[]>(),
    Schedule.countDocuments(filter),
  ]);
  sendResponse(res, 200, true, 'OK', data, { total, page: Number(page), limit: Number(limit) });
};

export const getByCustomer = async (req: Request, res: Response): Promise<void> => {
  const USER_FIELDS = '_id username name roles isActive createdAt';
  const CUSTOMER_FIELDS =
    '_id className school contactName contactPhone contactAddress total totalMale totalFemale notes createdAt';
  const schedule = await Schedule.findOne({ customer: req.params.customer })
    .populate('customer', CUSTOMER_FIELDS)
    .populate({ path: 'package', populate: { path: 'costumes' } })
    .populate('costumes')
    .populate('leadPhotographer', USER_FIELDS)
    .populate('supportPhotographers', USER_FIELDS)
    .populate('bookedBy', USER_FIELDS)
    .sort({ shootDate: -1 })
    .lean<ScheduleResponse | null>();
  sendResponse(res, 200, true, 'OK', schedule);
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  const USER_FIELDS = '_id username name roles isActive createdAt';
  const CUSTOMER_FIELDS =
    '_id className school contactName contactPhone contactAddress total totalMale totalFemale notes createdAt';
  const schedule = await Schedule.findById(req.params.id)
    .populate('customer', CUSTOMER_FIELDS)
    .populate({ path: 'package', populate: { path: 'costumes' } })
    .populate('costumes')
    .populate('leadPhotographer', USER_FIELDS)
    .populate('supportPhotographers', USER_FIELDS)
    .populate('bookedBy', USER_FIELDS)
    .lean<ScheduleResponse | null>();
  if (!schedule) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'OK', schedule);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  if (Object.prototype.hasOwnProperty.call(req.body, 'workflowBooking')) {
    sendResponse(
      res,
      400,
      false,
      'Workflow schedule links can only be managed by the booking workflow',
    );
    return;
  }
  const payload = { ...req.body };
  delete payload._id;
  delete payload.__v;
  delete payload.createdAt;
  delete payload.updatedAt;
  if (payload.season === undefined || payload.season === null || payload.season === '') {
    payload.season = await resolveSeasonForDate(payload.shootDate);
  }
  if (
    !Types.ObjectId.isValid(payload.customer) ||
    !(await Customer.exists({ _id: payload.customer }))
  ) {
    sendResponse(res, 400, false, 'Customer is required for a schedule');
    return;
  }
  let schedule: any;
  if (workflowEnabled()) {
    try {
      await withResourceTransaction(async (session) => {
        if (!(await Customer.exists({ _id: payload.customer }).session(session)))
          throw new WorkflowProblem(400, 'Customer is required for a schedule');
        await ensureScheduleResourcesAvailable(payload, session);
        [schedule] = await Schedule.create([payload], { session });
      });
    } catch (error) {
      sendScheduleProblem(res, error);
      return;
    }
  } else {
    schedule = await Schedule.create(payload);
  }

  // Lấy bản populate để dựng tên folder + nội dung thông báo
  const full = await Schedule.findById(schedule._id)
    .populate<{ customer: Pick<ICustomer, 'className' | 'school'> }>('customer', 'className school')
    .populate<{ leadPhotographer: Pick<IUser, 'name'> }>('leadPhotographer', 'name')
    .populate<{ supportPhotographers: Pick<IUser, 'name'>[] }>('supportPhotographers', 'name')
    .populate<{ season: Pick<ISeason, 'name'> }>('season', 'name')
    .lean();

  const dateStr = new Date(schedule.shootDate).toLocaleDateString('vi-VN');
  const ids = full
    ? [full.leadPhotographer, ...full.supportPhotographers]
        .filter(Boolean)
        .map((p) => String((p as { _id?: unknown })?._id ?? p))
    : [];

  // ── Tạo folder Drive + ghi Sheet ĐỒNG BỘ, lưu driveFolderUrl trước khi trả về ──
  if (full) {
    try {
      const leadName = (full.leadPhotographer as unknown as { name?: string })?.name;
      const supportNames = (full.supportPhotographers as unknown as { name?: string }[])
        .map((p) => p?.name)
        .filter((n): n is string => Boolean(n));
      const seasonName = (full.season as unknown as { name?: string })?.name ?? 'Chưa phân mùa';

      const result = await createFolderAndLog({
        scheduleId: String(full._id),
        season: seasonName,
        school: full.customer?.school ?? '',
        className: full.customer?.className ?? '',
        shootDate: dateStr,
        startTime: full.startTime,
        location: full.location,
        leadPhotographer: leadName,
        supportPhotographers: supportNames,
        contractUrl: full.contractUrl,
        status: full.status,
      });

      if (result?.folderUrl) {
        schedule.driveFolderUrl = result.folderUrl;
        schedule.driveFolderId = result.folderId;
        await schedule.save();
      }
    } catch (e) {
      console.error('[Schedule] tạo folder Drive thất bại:', e);
    }
  }

  // Trả response sau khi đã có driveFolderUrl (nếu tạo folder thành công)
  sendResponse(res, 201, true, 'Tạo lịch chụp thành công', schedule);

  // ── Thông báo Telegram chạy nền (không chặn response) ──
  if (ids.length) {
    const timeStr = schedule.startTime ? ` • ${schedule.startTime}` : '';
    const locationStr = schedule.location ? `\n📍 ${schedule.location}` : '';
    const customerName = full?.customer?.className ?? 'Khách hàng';
    const text =
      `📅 <b>Lịch chụp mới được tạo</b>\n` +
      `👥 ${customerName}\n` +
      `📆 ${dateStr}${timeStr}${locationStr}`;
    const folderUrl = schedule.driveFolderUrl;
    void (async () => {
      try {
        await notifyUsers(ids, text);
        if (folderUrl) {
          await notifyUsers(ids, `📁 <b>Folder ảnh đã tạo</b>\n🔗 ${folderUrl}`);
        }
      } catch (e) {
        console.error('[Schedule] gửi thông báo Telegram thất bại:', e);
      }
    })();
  }
};

export const update = async (req: Request, res: Response): Promise<void> => {
  if (Object.prototype.hasOwnProperty.call(req.body, 'workflowBooking')) {
    sendResponse(
      res,
      400,
      false,
      'Workflow schedule links can only be managed by the booking workflow',
    );
    return;
  }
  const updateData = { ...req.body };
  delete updateData._id;
  delete updateData.__v;
  delete updateData.createdAt;
  delete updateData.updatedAt;
  const resourceFields = [
    'customer',
    'package',
    'costumes',
    'costumeReservations',
    'shootDate',
    'startTime',
    'endTime',
    'location',
    'leadPhotographer',
    'supportPhotographers',
    'status',
  ];
  let prevSchedule: any;
  let schedule: any;
  const updateInTransaction = async (session?: ClientSession) => {
    const existingQuery = Schedule.findById(req.params.id);
    if (session) existingQuery.session(session);
    const existing = await existingQuery;
    if (!existing) throw new WorkflowProblem(404, 'Not found');
    prevSchedule = existing.toObject();
    if (existing.workflowBooking && resourceFields.some((field) => field in updateData)) {
      throw new WorkflowProblem(
        409,
        'Workflow-linked schedules must be changed or cancelled through the booking workflow',
      );
    }
    const proposed = { ...existing.toObject(), ...updateData };
    if (
      updateData.shootDate &&
      (updateData.season === undefined || updateData.season === null || updateData.season === '')
    ) {
      updateData.season = await resolveSeasonForDate(updateData.shootDate);
      proposed.season = updateData.season;
    }
    if (
      'customer' in updateData &&
      (!Types.ObjectId.isValid(proposed.customer) ||
        !(await Customer.exists({ _id: proposed.customer }).session(session ?? null)))
    ) {
      throw new WorkflowProblem(400, 'Customer is required for a schedule');
    }
    if (session)
      await ensureScheduleResourcesAvailable(proposed, session, existing._id as Types.ObjectId);
    schedule = await Schedule.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
      ...(session ? { session } : {}),
    });
  };
  try {
    if (workflowEnabled())
      await withResourceTransaction(async (session) => updateInTransaction(session));
    else await updateInTransaction();
  } catch (error) {
    sendScheduleProblem(res, error);
    return;
  }
  sendResponse(res, 200, true, 'Cập nhật thành công', schedule);

  if (!prevSchedule) return;

  void (async () => {
    try {
      const full = await Schedule.findById(schedule._id)
        .populate<{
          customer: Pick<ICustomer, 'className' | 'school'>;
        }>('customer', 'className school')
        .lean();
      if (!full) return;

      const dateStr = new Date(full.shootDate).toLocaleDateString('vi-VN');
      const customerName = full.customer?.className ?? 'Khách hàng';
      const customerSchool = full.customer?.school || '';
      const timeStr = full.startTime ? ` • ${full.startTime}` : '';
      const locationStr = full.location ? `\n📍 ${full.location}` : '';

      // ── 1. Phát hiện thay đổi thợ chụp ──────────────────────────────────
      // Chỉ tính thay đổi khi client thực sự gửi field tương ứng. Nếu chỉ cập
      // nhật field khác (vd: contractUrl) thì giữ nguyên thợ cũ, tránh báo nhầm
      // "được gỡ khỏi lịch chụp".
      const leadProvided = 'leadPhotographer' in req.body;
      const supportsProvided = Array.isArray(req.body?.supportPhotographers);

      const prevLead = prevSchedule.leadPhotographer?.toString() ?? null;
      const newLead = leadProvided
        ? req.body.leadPhotographer
          ? String(req.body.leadPhotographer)
          : null
        : prevLead;

      const prevSupports = (prevSchedule.supportPhotographers ?? []).map((id: any) =>
        id.toString(),
      );
      const newSupports: string[] = supportsProvided
        ? req.body.supportPhotographers.map(String)
        : prevSupports;

      // Thợ mới được thêm vào (chưa có trong lịch trước)
      const addedLead =
        newLead && newLead !== prevLead && !prevSupports.includes(newLead) ? [newLead] : [];
      const addedSupports = newSupports.filter(
        (id) => id !== prevLead && !prevSupports.includes(id),
      );
      const addedIds = [...new Set([...addedLead, ...addedSupports])];

      // Thợ bị gỡ ra
      const removedLead =
        prevLead && prevLead !== newLead && !newSupports.includes(prevLead) ? [prevLead] : [];
      const removedSupports = prevSupports.filter(
        (id: string) => id !== newLead && !newSupports.includes(id),
      );
      const removedIds = [...new Set([...removedLead, ...removedSupports])];

      if (addedIds.length) {
        const text =
          `📅 <b>Bạn được phân công lịch chụp</b>\n` +
          `👥 ${customerName} - ${customerSchool}\n` +
          `📆 ${dateStr}${timeStr}${locationStr}`;
        await notifyUsers(addedIds, text);
      }
      if (removedIds.length) {
        const text =
          `🗑 <b>Bạn đã được gỡ khỏi lịch chụp</b>\n` +
          `👥 ${customerName} - ${customerSchool}` +
          `\n📆 ${dateStr}${timeStr}${locationStr}`;
        await notifyUsers(removedIds, text);
      }

      // ── 2. Thông báo đổi status cho tất cả thợ hiện tại ─────────────────
      const newStatus = req.body?.status as string | undefined;
      if (newStatus && newStatus !== prevSchedule.status) {
        const statusLabel: Record<string, string> = {
          confirmed: '✅ Đã xác nhận',
          completed: '🎉 Hoàn thành',
          cancelled: '❌ Đã huỷ',
          pending: '⏳ Chờ xác nhận',
        };
        const text =
          `🔔 <b>Lịch chụp cập nhật trạng thái</b>\n` +
          `👥 ${customerName} - ${customerSchool}\n` +
          `📆 ${dateStr}${timeStr}${locationStr}\n` +
          `Trạng thái: ${statusLabel[newStatus] ?? newStatus}`;

        const currentIds = [full.leadPhotographer, ...full.supportPhotographers]
          .filter(Boolean)
          .map(String);
        if (currentIds.length) await notifyUsers(currentIds, text);
      }

      // ── 3. Thông báo tạo hợp đồng ──────────────────────────────────────
      const newContractUrl = req.body?.contractUrl as string | undefined;
      const prevContractUrl = prevSchedule.contractUrl ?? null;
      if (newContractUrl && newContractUrl !== prevContractUrl) {
        const text =
          `📄 <b>Hợp đồng đã được tạo</b>\n` +
          `👥 ${customerName} - ${customerSchool}\n` +
          `📆 ${dateStr}${timeStr}${locationStr}\n` +
          `🔗 ${newContractUrl}`;

        const currentIds = [full.leadPhotographer, ...full.supportPhotographers]
          .filter(Boolean)
          .map(String);
        if (currentIds.length) await notifyUsers(currentIds, text);
      }
    } catch (e) {
      console.error('[Telegram] schedule update notification failed:', e);
    }
  })();
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  // Lấy season name + folderId trước khi xoá để dọn folder Drive & dòng Sheet
  const target = await Schedule.findById(req.params.id)
    .populate<{ season: Pick<ISeason, 'name'> }>('season', 'name')
    .lean();
  if (!target) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  if (target.workflowBooking) {
    sendResponse(
      res,
      409,
      false,
      'Workflow-linked schedules cannot be deleted through the legacy route',
    );
    return;
  }
  try {
    if (workflowEnabled()) {
      await withResourceTransaction(async (session) => {
        const current = await Schedule.findById(req.params.id).session(session);
        if (!current) throw new WorkflowProblem(404, 'Not found');
        if (current.workflowBooking)
          throw new WorkflowProblem(
            409,
            'Workflow-linked schedules cannot be deleted through the legacy route',
          );
        await Schedule.deleteOne({ _id: current._id }, { session });
      });
    } else {
      await Schedule.findByIdAndDelete(req.params.id);
    }
  } catch (error) {
    sendScheduleProblem(res, error);
    return;
  }
  sendResponse(res, 200, true, 'Đã xóa lịch chụp');

  // Dọn dẹp Google Drive + Sheet (chạy nền, không chặn response)
  void deleteFolderAndRow({
    scheduleId: String(target._id),
    season: (target.season as unknown as { name?: string })?.name ?? 'Chưa phân mùa',
    folderId: target.driveFolderId,
  }).catch((e: unknown) => console.error('[Schedule] dọn Google Drive/Sheet khi xoá thất bại:', e));
};

export const exportContract = async (req: Request, res: Response): Promise<void> => {
  const schedule = await Schedule.findById(req.params.id)
    .populate<{
      customer: ICustomer;
    }>('customer', 'className school contactName contactPhone total')
    .populate<{ leadPhotographer: IUser }>('leadPhotographer', 'username name')
    .populate<{ supportPhotographers: IUser[] }>('supportPhotographers', 'username name');

  if (!schedule) {
    res.status(404).json({ message: 'Not found' });
    return;
  }

  let contractQuote = null;
  if (schedule.workflowBooking) {
    const version =
      req.query.quoteVersion === undefined ? undefined : Number(req.query.quoteVersion);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
      res.status(400).json({ message: 'Phiên bản báo giá không hợp lệ' });
      return;
    }
    const workflow = (await BookingWorkflow.findOne({
      booking: schedule.workflowBooking,
    }).lean()) as Pick<IBookingWorkflow, 'quote' | 'quoteHistory'> | null;
    contractQuote = selectAcceptedContractQuote(
      workflow?.quote,
      workflow?.quoteHistory ?? [],
      version,
    );
    if (!contractQuote) {
      res
        .status(409)
        .json({ message: 'Chưa có báo giá đã được khách chấp nhận cho phiên bản này' });
      return;
    }
  }
  const customer = schedule.customer as unknown as ICustomer;
  const lead = schedule.leadPhotographer as unknown as IUser | null;
  const supports = (schedule.supportPhotographers as unknown as IUser[]) ?? [];

  const formatDate = (d: Date | string) => {
    return new Date(d).toLocaleDateString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="hop-dong-${schedule._id}.pdf"`);
  doc.pipe(res);

  doc.registerFont('Regular', FONT_REGULAR).registerFont('Bold', FONT_BOLD);

  // ── Header ──────────────────────────────────────────────────────────────
  doc.font('Bold').fontSize(18).text('YUME STUDIO', { align: 'center' });
  doc
    .font('Regular')
    .fontSize(10)
    .text('ĐC: [Địa chỉ studio]  •  SĐT: [Số điện thoại]', { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);

  // ── Title ────────────────────────────────────────────────────────────────
  doc.font('Bold').fontSize(16).text('HỢP ĐỒNG CHỤP ẢNH KỶ YẾU', { align: 'center' });
  doc
    .font('Regular')
    .fontSize(10)
    .text(`Số hợp đồng: HD-${String(schedule._id).slice(-6).toUpperCase()}`, { align: 'center' });
  doc.moveDown(1);

  // ── Parties ──────────────────────────────────────────────────────────────
  doc.font('Bold').fontSize(12).text('A. CÁC BÊN THAM GIA HỢP ĐỒNG');
  doc.moveDown(0.3);
  doc.font('Bold').fontSize(10).text('BÊN A (Studio):');
  doc
    .font('Regular')
    .fontSize(10)
    .text('Tên: Yume Studio')
    .text('Địa chỉ: [Địa chỉ studio]')
    .text('Điện thoại: [Số điện thoại]');
  doc.moveDown(0.5);

  doc.font('Bold').fontSize(10).text('BÊN B (Khách hàng):');
  doc
    .font('Regular')
    .fontSize(10)
    .text(`Đại diện lớp: ${customer?.contactName ?? '____________________'}`)
    .text(`Lớp / Trường: ${customer?.className ?? ''} – ${customer?.school ?? ''}`)
    .text(`Số điện thoại: ${customer?.contactPhone ?? '____________________'}`);
  doc.moveDown(1);

  // ── Schedule details ─────────────────────────────────────────────────────
  doc.font('Bold').fontSize(12).text('B. THÔNG TIN BUỔI CHỤP');
  doc.moveDown(0.3);

  const rows: [string, string][] = [
    ['Ngày chụp', formatDate(contractQuote?.proposedSchedule.shootDate ?? schedule.shootDate)],
    ['Giờ bắt đầu', contractQuote?.proposedSchedule.startTime ?? schedule.startTime ?? '—'],
    ['Giờ kết thúc', contractQuote?.proposedSchedule.endTime ?? schedule.endTime ?? '—'],
    ['Địa điểm', contractQuote?.proposedSchedule.location ?? schedule.location ?? '—'],
    ['Thợ leader', lead ? (lead.name ?? lead.username) : '—'],
    ['Thợ support', supports.length ? supports.map((u) => u.name ?? u.username).join(', ') : '—'],
    ['Số lượng học sinh', String(customer?.total ?? '—')],
  ];

  for (const [label, value] of rows) {
    const y = doc.y;
    doc
      .font('Bold')
      .fontSize(10)
      .text(label + ':', 50, y, { width: 150, continued: false });
    doc.font('Regular').fontSize(10).text(value, 210, y);
    doc.moveDown(0.1);
  }
  doc.moveDown(0.8);

  // ── Terms ────────────────────────────────────────────────────────────────
  doc.font('Bold').fontSize(12).text('C. ĐIỀU KHOẢN HỢP ĐỒNG');
  doc.moveDown(0.3);
  const terms = contractQuote
    ? acceptedContractTerms(contractQuote)
    : [
        '1. Studio cam kết thực hiện đúng lịch chụp đã thoả thuận. Trường hợp bất khả kháng sẽ thông báo trước ít nhất 24 giờ.',
        '2. Bên B cần xác nhận lịch chụp trước 48 giờ. Nếu huỷ sau thời hạn này, khoản đặt cọc sẽ không được hoàn lại.',
        '3. Ảnh gốc sẽ được bàn giao sau khi bên B thanh toán đầy đủ.',
        '4. Thời gian bàn giao ảnh chỉnh sửa: trong vòng 30 ngày làm việc kể từ ngày chụp.',
        '5. Mọi tranh chấp phát sinh sẽ được giải quyết trên tinh thần thương lượng, hoà giải.',
      ];
  for (const t of terms) {
    doc.font('Regular').fontSize(10).text(t, { width: 495 });
    doc.moveDown(0.3);
  }
  doc.moveDown(0.8);

  // ── Notes ────────────────────────────────────────────────────────────────
  if (schedule.notes) {
    doc.font('Bold').fontSize(12).text('D. GHI CHÚ THÊM');
    doc.moveDown(0.3);
    doc.font('Regular').fontSize(10).text(schedule.notes, { width: 495 });
    doc.moveDown(0.8);
  }

  // ── Signatures ───────────────────────────────────────────────────────────
  doc
    .font('Regular')
    .fontSize(10)
    .text(`Hà Nội, ngày ${formatDate(new Date())}`, { align: 'right' });
  doc.moveDown(1);

  const sigY = doc.y;
  doc.font('Bold').fontSize(10).text('ĐẠI DIỆN BÊN A', 50, sigY, { width: 220, align: 'center' });
  doc.font('Bold').fontSize(10).text('ĐẠI DIỆN BÊN B', 325, sigY, { width: 220, align: 'center' });
  doc
    .font('Regular')
    .fontSize(9)
    .text('(Ký và ghi rõ họ tên)', 50, doc.y, { width: 220, align: 'center' });
  doc
    .font('Regular')
    .fontSize(9)
    .text('(Ký và ghi rõ họ tên)', 325, doc.y, { width: 220, align: 'center' });

  doc.end();
};
