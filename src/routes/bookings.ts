import { Router } from 'express';
import { createHash } from 'crypto';
import { isValidObjectId } from 'mongoose';
import Booking from '../models/Booking';
import Package from '../models/Package';
import User from '../models/User';
import BookingWorkflow from '../models/BookingWorkflow';
import { workflowPhotographers } from '../services/workflowPhotographer';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { asyncHandler } from '../middleware/asyncHandler';
import { sendResponse } from '../utils/response';
import { boundedInteger, trimmedText } from '../utils/input';
import { requireClientPortal } from '../middleware/featureFlags';
import {
  createBookingWithCostumes,
  parseCostumeSelections,
  releaseBookingCostumes,
  reviewBookingWithCostumes,
} from '../services/bookingCostumes';
import { bookingCostumeDto } from '../services/bookingCostumeHolds';
import { WorkflowProblem } from '../services/workflowTransactions';
import type { Request, Response } from 'express';
import {
  getWorkflow,
  executeWorkflowAction,
  listWorkflows,
  replaceWorkflowMembers,
} from '../controllers/workflowController';

const router = Router();
router.use(requireClientPortal);
router.use(protect);
const isAdmin = (roles: number[]) => roles.some((role) => role === 0 || role === 1);
const bookingStatuses = ['pending', 'approved', 'rejected'] as const;
const bookingHandler = (work: (req: Request, res: Response) => Promise<void>) =>
  asyncHandler(async (req, res) => {
    try {
      await work(req, res);
    } catch (error) {
      if (!(error instanceof WorkflowProblem)) throw error;
      const message =
        error.status === 503
          ? 'Chức năng giữ trang phục tạm thời chưa sẵn sàng. Vui lòng thử lại sau.'
          : error.message;
      sendResponse(res, error.status, false, message, {
        costumeConflicts: (error as WorkflowProblem & { costumeConflicts?: unknown })
          .costumeConflicts,
      });
    }
  });

const fingerprint = (parts: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

router.get(
  '/notifications',
  requireRole(0, 1, 6),
  asyncHandler(async (req, res) => {
    const admin = isAdmin(req.user!.roles);
    const filter = admin ? {} : { client: req.user!._id };
    const records = await Booking.find(filter)
      .select('events packageName')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    const audience = admin ? 'admin' : 'client';
    const readAt = req.user!.notificationReadAt?.getTime() ?? 0;
    const data = records
      .flatMap((booking) =>
        booking.events
          .filter((event) => event.audience === audience)
          .map((event) => ({
            _id: event._id,
            bookingId: booking._id,
            message: event.message,
            at: event.at,
            unread: event.at.getTime() > readAt,
          })),
      )
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 100);
    sendResponse(res, 200, true, 'OK', data);
  }),
);
router.post(
  '/notifications/read',
  requireRole(0, 1, 6),
  asyncHandler(async (req, res) => {
    // Read only through the timestamp the browser actually displayed.
    const at = typeof req.body.at === 'string' ? new Date(req.body.at) : new Date(NaN);
    if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now()) {
      sendResponse(res, 400, false, 'Thời điểm không hợp lệ');
      return;
    }
    await User.updateOne({ _id: req.user!._id }, { $max: { notificationReadAt: at } });
    sendResponse(res, 200, true, 'Đã đánh dấu đã đọc');
  }),
);
router.get('/workflow', requireRole(0, 1, 3, 5, 6), asyncHandler(listWorkflows));
router.get(
  '/',
  requireRole(0, 1, 6),
  asyncHandler(async (req, res) => {
    const page = boundedInteger(req.query.page ?? 1, 1, 100_000);
    const limit = boundedInteger(req.query.limit ?? 20, 1, 50);
    if (!page || !limit) {
      sendResponse(res, 400, false, 'Thông tin phân trang không hợp lệ');
      return;
    }
    const filter: Record<string, unknown> = isAdmin(req.user!.roles)
      ? {}
      : { client: req.user!._id };
    if (req.query.status !== undefined) {
      const status = String(req.query.status);
      if (!bookingStatuses.includes(status as (typeof bookingStatuses)[number])) {
        sendResponse(res, 400, false, 'Trạng thái lọc không hợp lệ');
        return;
      }
      filter.status = status;
    }
    const [data, total] = await Promise.all([
      Booking.find(filter)
        .select('-events -reviewedBy')
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Booking.countDocuments(filter),
    ]);
    const workflows = await BookingWorkflow.find({
      booking: { $in: data.map((item) => item._id) },
    }).lean();
    const assignments = await workflowPhotographers(workflows);
    sendResponse(
      res,
      200,
      true,
      'OK',
      data.map((item) => ({
        ...item,
        assignedPhotographer: assignments.get(String(item._id))?.assignedPhotographer ?? null,
        assignedSupportPhotographers:
          assignments.get(String(item._id))?.assignedSupportPhotographers ?? [],
      })),
      { total, page, limit },
    );
  }),
);
router.post(
  '/',
  requireRole(6),
  bookingHandler(async (req, res) => {
    const { packageId, startAt, endAt } = req.body;
    const members = boundedInteger(req.body.members, 1, 1000);
    const contactName = trimmedText(req.body.contactName, 100);
    const phone = trimmedText(req.body.phone, 25);
    const className = trimmedText(req.body.className ?? '', 120, false);
    const school = trimmedText(req.body.school ?? '', 160, false);
    const location = trimmedText(req.body.location, 300);
    const note = trimmedText(req.body.note ?? '', 2000, false);
    const idempotencyKey = req.get('Idempotency-Key')?.trim();
    const start = new Date(typeof startAt === 'string' ? startAt : '');
    const end = new Date(typeof endAt === 'string' ? endAt : '');
    if (!phone || !/^(?:0|\+84)[1-9]\d{8}$/.test(phone.replace(/[ ().-]/g, ''))) {
      sendResponse(
        res,
        400,
        false,
        'Nhập số điện thoại gồm 10 chữ số bắt đầu bằng 0 hoặc dạng +84 (ví dụ: 0901234567).',
      );
      return;
    }
    if (
      typeof packageId !== 'string' ||
      !isValidObjectId(packageId) ||
      !contactName ||
      className === null ||
      school === null ||
      !location ||
      note === null ||
      members === null ||
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start.getTime() <= Date.now() ||
      end <= start ||
      end.getTime() - start.getTime() > 7 * 86400000 ||
      (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
    ) {
      sendResponse(
        res,
        400,
        false,
        'Kiểm tra thông tin liên hệ, số người và khoảng thời gian mong muốn (tối đa 7 ngày).',
      );
      return;
    }
    const costumeSelections = parseCostumeSelections(req.body.costumeSelections);
    const requestFingerprint = fingerprint([
      packageId,
      members,
      contactName,
      phone,
      start.toISOString(),
      end.toISOString(),
      location,
      note,
      ...(costumeSelections.length ? [costumeSelections] : []),
    ]);

    if (idempotencyKey) {
      const existing = await Booking.findOne({
        client: req.user!._id,
        clientRequestId: idempotencyKey,
      })
        .select('+requestFingerprint')
        .lean();
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          sendResponse(res, 409, false, 'Mã gửi yêu cầu đã được dùng cho nội dung khác');
          return;
        }
        sendResponse(res, 200, true, 'Yêu cầu đã được ghi nhận trước đó', { _id: existing._id });
        return;
      }
    }

    const selected = await Package.findById(packageId);
    if (!selected) {
      sendResponse(res, 404, false, 'Gói dịch vụ không còn tồn tại');
      return;
    }

    const payload = {
      client: req.user!._id,
      clientRequestId: idempotencyKey,
      requestFingerprint,
      package: selected._id,
      packageName: selected.name,
      className: className || undefined,
      school: school || undefined,
      pricePerMember: selected.pricePerMember,
      packageSnapshot: {
        name: selected.name,
        pricePerMember: selected.pricePerMember,
        duration: selected.duration,
        costumeIds: selected.costumes ?? [],
        crewRatio: selected.crewRatio,
        editingScope: selected.editingScope,
        deliveryDays: selected.deliveryDays,
        studentsPerCrew: selected.studentsPerCrew,
        description: selected.description,
      },
      members,
      contactName,
      phone,
      location,
      note,
      startAt: start,
      endAt: end,
      status: 'pending',
      events: [
        {
          audience: 'client',
          message:
            'Đã nhận yêu cầu đặt dịch vụ. Studio sẽ kiểm tra và phản hồi; thời gian này chưa được giữ chỗ.',
        },
        {
          audience: 'admin',
          message: `${contactName} gửi yêu cầu ${selected.name}. Cần kiểm tra và phản hồi.`,
        },
      ],
    };

    if (costumeSelections.length) {
      const result = await createBookingWithCostumes(payload, costumeSelections);
      sendResponse(res, result.created ? 201 : 200, true, 'Đã ghi nhận yêu cầu và trang phục', {
        _id: result._id,
      });
      return;
    }

    if (idempotencyKey) {
      const result = await Booking.updateOne(
        { client: req.user!._id, clientRequestId: idempotencyKey },
        { $setOnInsert: payload },
        { upsert: true },
      );
      const stored = await Booking.findOne({
        client: req.user!._id,
        clientRequestId: idempotencyKey,
      })
        .select('+requestFingerprint')
        .lean();
      if (!stored) throw new Error('Booking upsert completed without a readable record');
      if (stored.requestFingerprint !== requestFingerprint) {
        sendResponse(res, 409, false, 'Mã gửi yêu cầu đã được dùng cho nội dung khác');
        return;
      }
      sendResponse(
        res,
        result.upsertedCount ? 201 : 200,
        true,
        result.upsertedCount ? 'Đã gửi yêu cầu' : 'Yêu cầu đã được ghi nhận trước đó',
        { _id: stored._id },
      );
      return;
    }

    const data = await Booking.create(payload);
    sendResponse(res, 201, true, 'Đã gửi yêu cầu', { _id: data._id });
  }),
);
router.get(
  '/:id',
  requireRole(0, 1, 6),
  asyncHandler(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      sendResponse(res, 404, false, 'Không tìm thấy booking');
      return;
    }
    const filter = isAdmin(req.user!.roles)
      ? { _id: req.params.id }
      : { _id: req.params.id, client: req.user!._id };
    const data = await Booking.findOne(filter).select('-reviewedBy').lean();
    if (!data) {
      sendResponse(res, 404, false, 'Không tìm thấy booking');
      return;
    }
    const events = data.events.filter(
      (event) => event.audience === (isAdmin(req.user!.roles) ? 'admin' : 'client'),
    );
    sendResponse(res, 200, true, 'OK', { ...data, ...bookingCostumeDto(data), events });
  }),
);
router.patch(
  '/:id/review',
  requireRole(0, 1),
  bookingHandler(async (req, res) => {
    const status = req.body.status;
    const reviewNote = trimmedText(req.body.note, 2000);
    if (
      !isValidObjectId(req.params.id) ||
      !['approved', 'rejected'].includes(status) ||
      !reviewNote
    ) {
      sendResponse(
        res,
        400,
        false,
        'Chọn quyết định và nhập nội dung phản hồi (tối đa 2000 ký tự).',
      );
      return;
    }
    const existing = await Booking.findOne({ _id: req.params.id }).select('costumeHold').lean();
    if (existing?.costumeHold) {
      const data = await reviewBookingWithCostumes(
        req.params.id,
        status,
        reviewNote,
        req.user!._id,
      );
      sendResponse(res, 200, true, 'Đã phản hồi yêu cầu', { _id: data._id });
      return;
    }
    const at = new Date();
    const message = `${status === 'approved' ? 'Studio đã duyệt yêu cầu; lịch chính thức sẽ được liên hệ xác nhận.' : 'Studio đã từ chối yêu cầu.'} ${reviewNote}`;
    // Status and notifications commit together; concurrent reviews cannot overwrite a decision.
    const data = await Booking.findOneAndUpdate(
      { _id: req.params.id, status: 'pending', startAt: { $gt: at } },
      {
        $set: { status, reviewNote, reviewedBy: req.user!._id, reviewedAt: at },
        $push: {
          events: {
            $each: [
              { audience: 'client', message, at },
              { audience: 'admin', message, at },
            ],
          },
        },
      },
      { new: true },
    );
    if (!data) {
      sendResponse(
        res,
        409,
        false,
        'Yêu cầu đã được xử lý hoặc thời gian mong muốn đã qua. Hãy tải lại.',
      );
      return;
    }
    sendResponse(res, 200, true, 'Đã phản hồi yêu cầu', { _id: data._id });
  }),
);

router.patch(
  '/:id/costume-hold/release',
  requireRole(0, 1),
  bookingHandler(async (req, res) => {
    const note = trimmedText(req.body.note, 2000);
    if (!note) throw new WorkflowProblem(400, 'Nhập lý do bỏ giữ trang phục (tối đa 2.000 ký tự).');
    const booking = await releaseBookingCostumes(req.params.id, note);
    sendResponse(res, 200, true, 'Đã bỏ giữ trang phục', bookingCostumeDto(booking));
  }),
);

router.get('/workflow/:id', (req, res, next) => {
  // GET /workflow/:id is kept as an alias for clients that group the route by resource.
  getWorkflow(req, res).catch(next);
});

router.get('/:id/workflow', (req, res, next) => getWorkflow(req, res).catch(next));
router.post('/:id/workflow/members', (req, res, next) =>
  replaceWorkflowMembers(req, res).catch(next),
);
router.post('/:id/workflow/actions', (req, res, next) =>
  executeWorkflowAction(req, res).catch(next),
);

export default router;
