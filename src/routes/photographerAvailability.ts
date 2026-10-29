import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import Booking from '../models/Booking';
import BookingWorkflow from '../models/BookingWorkflow';
import Schedule from '../models/Schedule';
import User from '../models/User';
import PhotographerUnavailability from '../models/PhotographerUnavailability';
import {
  photographerAvailability,
  parsePhotographerInterval,
  scheduleInterval,
  intervalsConflict,
  vietnamDay,
} from '../services/photographerAvailability';
import { withResourceTransaction, WorkflowProblem } from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';
import type { Request, Response } from 'express';

const router = Router();
router.use(protect);
const isAdmin = (req: Request) => req.user!.roles.some((role) => role === 0 || role === 1);
const handle =
  (work: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      await work(req, res);
    } catch (error) {
      const problem = error as WorkflowProblem;
      sendResponse(res, problem.status ?? 500, false, problem.message);
    }
  };

router.get(
  '/availability',
  requireRole(0, 1),
  handle(async (req, res) => {
    const interval = parsePhotographerInterval(req.query.startAt, req.query.endAt);
    let excludeSchedule;
    if (req.query.bookingId !== undefined) {
      if (
        !isValidObjectId(req.query.bookingId) ||
        !(await Booking.exists({ _id: req.query.bookingId }))
      )
        throw new WorkflowProblem(404, 'Không tìm thấy đơn.');
      const workflow: any = await BookingWorkflow.findOne({ booking: req.query.bookingId })
        .select('resources.schedule')
        .lean();
      excludeSchedule = workflow?.resources?.schedule;
    }
    sendResponse(
      res,
      200,
      true,
      'OK',
      await photographerAvailability(interval, { excludeSchedule }),
    );
  }),
);

router.get(
  '/unavailability',
  requireRole(0, 1, 3),
  handle(async (req, res) => {
    const photographer = isAdmin(req) ? req.query.photographerId : String(req.user!._id);
    if (!isValidObjectId(photographer)) throw new WorkflowProblem(400, 'Chọn thợ chụp hợp lệ.');
    // Only an owner's records or the admin's explicitly selected photographer are returned.
    const rows = await PhotographerUnavailability.find({ photographer })
      .sort({ startAt: 1 })
      .lean();
    sendResponse(res, 200, true, 'OK', rows);
  }),
);

const saveBlock = handle(async (req, res) => {
  const body = req.body ?? {};
  const interval = parsePhotographerInterval(body.startAt, body.endAt);
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 1000))
    throw new WorkflowProblem(400, 'Ghi chú tối đa 1.000 ký tự.');
  let result;
  await withResourceTransaction(async (session) => {
    const existing = req.params.id
      ? isValidObjectId(req.params.id)
        ? await PhotographerUnavailability.findById(req.params.id).session(session)
        : null
      : null;
    if (
      req.params.id &&
      (!existing || (!isAdmin(req) && String(existing.photographer) !== String(req.user!._id)))
    )
      throw new WorkflowProblem(404, 'Không tìm thấy lịch bận.');
    const photographer =
      existing?.photographer ?? (isAdmin(req) ? body.photographerId : req.user!._id);
    if (
      !isValidObjectId(photographer) ||
      !(await User.exists({ _id: photographer, roles: 3, isActive: true }).session(session))
    )
      throw new WorkflowProblem(400, 'Chọn thợ chụp đang hoạt động.');
    const schedules = await Schedule.find({
      status: { $in: ['pending', 'confirmed'] },
      shootDate: {
        $gte: new Date(vietnamDay(new Date(interval.start)) - 86400000),
        $lt: new Date(vietnamDay(new Date(interval.end)) + 2 * 86400000),
      },
      $or: [{ leadPhotographer: photographer }, { supportPhotographers: photographer }],
    })
      .session(session)
      .lean();
    const conflict = schedules.find((row) => {
      const range = scheduleInterval(row) ?? {
        start: vietnamDay(row.shootDate),
        end: vietnamDay(row.shootDate) + 86400000,
      };
      return intervalsConflict(interval, range);
    });
    if (conflict)
      throw new WorkflowProblem(
        409,
        `Đã có lịch chụp ${conflict.startTime ?? '?'}–${conflict.endTime ?? '?'}; hãy xử lý lịch chụp trước.`,
      );
    if (existing) {
      existing.startAt = new Date(interval.start);
      existing.endAt = new Date(interval.end);
      existing.note = body.note?.trim() ?? '';
      result = await existing.save({ session });
    } else {
      [result] = await PhotographerUnavailability.create(
        [
          {
            photographer,
            startAt: new Date(interval.start),
            endAt: new Date(interval.end),
            note: body.note?.trim() ?? '',
          },
        ],
        { session },
      );
    }
  });
  sendResponse(res, req.params.id ? 200 : 201, true, 'Đã lưu lịch bận.', result);
});
router.post('/unavailability', requireRole(0, 1, 3), saveBlock);
router.put('/unavailability/:id', requireRole(0, 1, 3), saveBlock);
router.delete(
  '/unavailability/:id',
  requireRole(0, 1, 3),
  handle(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw new WorkflowProblem(404, 'Không tìm thấy lịch bận.');
    await withResourceTransaction(async (session) => {
      const removed = await PhotographerUnavailability.findOneAndDelete({
        _id: req.params.id,
        ...(!isAdmin(req) ? { photographer: req.user!._id } : {}),
      }).session(session);
      if (!removed) throw new WorkflowProblem(404, 'Không tìm thấy lịch bận.');
    });
    sendResponse(res, 200, true, 'Đã xóa lịch bận.');
  }),
);

export default router;
