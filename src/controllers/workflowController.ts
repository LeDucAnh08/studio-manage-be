import crypto, { createHash } from 'crypto';
import { Request, Response } from 'express';
import { ClientSession, Types, isValidObjectId } from 'mongoose';
import Booking from '../models/Booking';
import BookingWorkflow, { IBookingWorkflow } from '../models/BookingWorkflow';
import Category from '../models/Category';
import Costume from '../models/Costume';
import Customer from '../models/Customer';
import Feedback from '../models/Feedback';
import Schedule from '../models/Schedule';
import Student from '../models/Student';
import Transaction from '../models/Transaction';
import User from '../models/User';
import {
  withResourceTransaction,
  WorkflowProblem,
  workflowEnabled,
} from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';
import { rentalReservations, rentalUsed } from '../services/rentalAvailability';
import { bookingCostumeDto } from '../services/bookingCostumeHolds';
import {
  ensurePhotographersAvailable,
  scheduleInterval,
} from '../services/photographerAvailability';
import { workflowPhotographers } from '../services/workflowPhotographer';

type Actor = NonNullable<Request['user']>;
type ActionBody = Record<string, any> & { action?: string; expectedVersion?: number };
const admin = (actor: Actor) => actor.roles.some((role) => role === 0 || role === 1);
const owner = (booking: { client: unknown }, actor: Actor) =>
  String(booking.client) === String(actor._id);
const isRole = (actor: Actor, role: number) => actor.roles.includes(role as never);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dayStart = (value: Date | string) => {
  // Schedule dates are calendar dates in Vietnam, regardless of the server TZ.
  const shifted = new Date(new Date(value).getTime() + 7 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
      7 * 60 * 60 * 1000,
  );
};
const parseTime = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};
const cleanText = (value: unknown, max: number, required = true): string | null => {
  if (typeof value !== 'string') return required ? null : '';
  const text = value.trim();
  if ((!text && required) || text.length > max) return null;
  return text;
};
const safeUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && value.length <= 2000
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};
const netReceived = (workflow: IBookingWorkflow): number =>
  workflow.payments.reduce(
    (sum, item) => sum + (item.kind === 'refund' ? -item.amount : item.amount),
    0,
  );
const grossReceived = (workflow: IBookingWorkflow): number =>
  workflow.payments.reduce((sum, item) => sum + (item.kind === 'refund' ? 0 : item.amount), 0);
const refundTotal = (workflow: IBookingWorkflow): number =>
  workflow.payments.reduce((sum, item) => sum + (item.kind === 'refund' ? item.amount : 0), 0);
const quoteTotal = (workflow: IBookingWorkflow): number =>
  workflow.quote?.lines?.reduce(
    (sum: number, item: any) => sum + item.quantity * item.unitPrice,
    0,
  ) ?? 0;
const settled = (workflow: IBookingWorkflow): boolean =>
  !!workflow.quote && netReceived(workflow) === quoteTotal(workflow);
const isAppliedFinancialChange = (workflow: IBookingWorkflow): boolean =>
  workflow.changeRequest?.status === 'applied' &&
  ['change', 'cancel'].includes(workflow.changeRequest.kind);
const paymentReadiness = () => {
  const paymentInstructions = {
    bankName: process.env.PAYMENT_BANK_NAME?.trim() ?? '',
    accountName: process.env.PAYMENT_ACCOUNT_NAME?.trim() ?? '',
    accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER?.trim() ?? '',
    transferTemplate: process.env.PAYMENT_TRANSFER_TEMPLATE?.trim() ?? 'YUME {bookingId}',
  };
  return {
    paymentInstructions,
    paymentReady: Boolean(
      paymentInstructions.bankName &&
      paymentInstructions.accountName &&
      paymentInstructions.accountNumber,
    ),
  };
};

const scheduleDto = (workflow: IBookingWorkflow) =>
  workflow.resources.schedule ? String(workflow.resources.schedule) : null;

const toDto = async (booking: any, workflow: IBookingWorkflow | null, actor: Actor) => {
  const clientView = owner(booking, actor);
  const canManage = admin(actor);
  const assignment = workflow
    ? ((await workflowPhotographers([workflow])).get(String(booking._id)) ?? null)
    : null;
  const assignedPhotographer = assignment?.assignedPhotographer ?? null;
  const assignedSupportPhotographers = assignment?.assignedSupportPhotographers ?? [];
  const isAssigned =
    isRole(actor, 3) &&
    (assignedPhotographer?._id === String(actor._id) ||
      assignedSupportPhotographers.some((person) => person._id === String(actor._id)) ||
      !!workflow?.resources?.photographers?.some((id) => String(id) === String(actor._id)));
  if (!clientView && !canManage && !isAssigned && !isRole(actor, 5)) {
    throw new WorkflowProblem(404, 'Không tìm thấy booking');
  }

  const quote = workflow?.quote
    ? {
        version: workflow.quote.version,
        currency: workflow.quote.currency,
        lines: workflow.quote.lines,
        total: quoteTotal(workflow),
        depositRequired: workflow.quote.depositRequired,
        proposedSchedule: workflow.quote.proposedSchedule,
        delivery: workflow.quote.delivery,
        editingTerms: workflow.quote.editingTerms,
        terms: workflow.quote.terms,
        paymentInstructions: workflow.quote.paymentInstructions,
        acceptedAt: workflow.quote.acceptedAt,
      }
    : null;
  const transactions = workflow?.payments ?? [];
  const financialView = clientView || canManage || isRole(actor, 5);
  const packageCostumeTypes = booking.packageSnapshot?.costumeIds ?? [];
  const costumeRows =
    clientView || canManage
      ? await Costume.find({ type: { $in: packageCostumeTypes } })
          .select('name inventory')
          .sort({ name: 1 })
          .lean()
      : [];
  const allowedCostumes = costumeRows.map((item: any) => ({
    costumeId: String(item._id),
    name: item.name,
    sizes: [
      ...new Set(
        (item.inventory ?? [])
          .filter((row: any) => row.condition === 'good' && row.quantity > 0)
          .map((row: any) => row.size),
      ),
    ].sort(),
  }));
  const payments = {
    requiredDeposit: workflow?.quote?.depositRequired ?? 0,
    totalReceived: grossReceived(workflow ?? ({ payments: [] } as unknown as IBookingWorkflow)),
    totalRefunded: refundTotal(workflow ?? ({ payments: [] } as unknown as IBookingWorkflow)),
    netReceived: netReceived(workflow ?? ({ payments: [] } as unknown as IBookingWorkflow)),
    totalDue: Math.max(
      0,
      (workflow ? currentPayable(workflow) : 0) - (workflow ? netReceived(workflow) : 0),
    ),
    refundDue:
      workflow && isAppliedFinancialChange(workflow)
        ? Math.max(0, netReceived(workflow) - currentPayable(workflow))
        : 0,
    entries: transactions.map((item: any) => ({
      _id: String(item._id),
      kind: item.kind,
      amount: item.amount,
      method: item.method,
      reference: item.reference,
      receivedAt: item.receivedAt,
    })),
  };
  const resources = workflow
    ? {
        scheduleId: scheduleDto(workflow),
        scheduleDetails: workflow.resources.schedule
          ? await Schedule.findById(workflow.resources.schedule)
              .select('shootDate startTime endTime location')
              .lean()
          : null,
        photographers: workflow.resources.photographers.map(String),
        costumes: workflow.resources.costumes.map((item: any) => ({
          costumeId: String(item.costumeId),
          size: item.size,
          quantity: item.quantity,
          receiveDate: item.receiveDate,
          returnDate: item.returnDate,
        })),
      }
    : null;
  const allowMemberRead = clientView || canManage || isAssigned;
  const members = allowMemberRead
    ? (workflow?.members ?? []).map((item: any) => ({
        _id: String(item._id),
        studentId: item.student ? String(item.student) : null,
        name: item.name,
        gender: item.gender,
        height: item.height,
        weight: item.weight,
        contact: item.contact,
        costumeSizes: (item.costumeSizes ?? []).map((size: any) => ({
          costumeId: String(size.costumeId),
          size: size.size,
        })),
      }))
    : [];
  const progress = workflow
    ? {
        status: workflow.progress.status,
        deliveryVersion: workflow.progress.deliveryVersion,
        deliveryUrl:
          clientView || canManage || isAssigned ? workflow.progress.deliveryUrl : undefined,
        deliveredAt: workflow.progress.deliveredAt,
        acceptedAt: workflow.progress.acceptedAt,
        acceptedDeliveryVersion: workflow.progress.acceptedDeliveryVersion,
        revisionRequests: (clientView || canManage || isAssigned
          ? workflow.progress.revisionRequests
          : []
        ).map((item: any) => ({
          _id: String(item._id),
          note: item.note,
          deliveryVersion: item.deliveryVersion,
          at: item.at,
          resolvedAt: item.resolvedAt,
        })),
      }
    : null;
  const feedback = workflow?.feedback?.rating
    ? {
        rating: workflow.feedback.rating,
        comment: workflow.feedback.comment,
        at: workflow.feedback.at,
      }
    : null;
  const readiness = paymentReadiness();
  return {
    booking: {
      _id: String(booking._id),
      status: booking.status,
      packageName: booking.packageName,
      pricePerMember: booking.pricePerMember,
      members: booking.members,
      className: booking.className,
      school: booking.school,
      contactName: clientView || canManage || isAssigned ? booking.contactName : undefined,
      phone: clientView || canManage || isAssigned ? booking.phone : undefined,
      startAt: booking.startAt,
      endAt: booking.endAt,
      location: booking.location,
      note: clientView || canManage || isAssigned ? booking.note : undefined,
      ...(clientView || canManage ? bookingCostumeDto(booking) : {}),
    },
    workflow: {
      bookingId: String(booking._id),
      version: workflow?.version ?? 0,
      lifecycle: workflow?.lifecycle ?? 'intake',
      assignedPhotographer,
      assignedSupportPhotographers,
      proposedSchedule:
        (clientView || canManage || isAssigned) && workflow?.quote
          ? workflow.quote.proposedSchedule
          : null,
      quote: financialView ? quote : null,
      quoteHistory: financialView
        ? (workflow?.quoteHistory ?? []).map((item: any) => ({
            version: item.version,
            total: item.lines.reduce(
              (sum: number, line: any) => sum + line.quantity * line.unitPrice,
              0,
            ),
            depositRequired: item.depositRequired,
            acceptedAt: item.acceptedAt,
          }))
        : [],
      payments: financialView ? payments : null,
      resources,
      members: allowMemberRead ? members : [],
      allowedCostumes,
      progress,
      deliveryHistory:
        clientView || canManage
          ? (workflow?.deliveryHistory ?? []).map((item: any) => ({
              version: item.version,
              deliveryUrl: item.deliveryUrl,
              deliveredAt: item.deliveredAt,
            }))
          : [],
      changeRequest:
        workflow?.changeRequest && (clientView || canManage)
          ? {
              _id: String(workflow.changeRequest._id),
              kind: workflow.changeRequest.kind,
              status: workflow.changeRequest.status,
              requested: workflow.changeRequest.requested,
              proposed: workflow.changeRequest.proposed,
              priceDelta: financialView ? workflow.changeRequest.priceDelta : undefined,
              finalPayable: financialView ? workflow.changeRequest.finalPayable : undefined,
              refundDue: financialView ? workflow.changeRequest.refundDue : undefined,
              terms: workflow.changeRequest.terms,
              note: workflow.changeRequest.note,
              at: workflow.changeRequest.at,
            }
          : null,
      changeHistory:
        clientView || canManage
          ? (workflow?.changeHistory ?? []).map((item: any) => ({
              _id: String(item._id),
              kind: item.kind,
              status: item.status,
              finalPayable: financialView ? item.finalPayable : undefined,
              refundDue: financialView ? item.refundDue : undefined,
              terms: item.terms,
              at: item.at,
            }))
          : [],
      feedback: clientView || canManage ? feedback : null,
      paymentInstructions: financialView ? readiness.paymentInstructions : null,
      paymentReady: financialView && readiness.paymentReady,
      events: (workflow?.events ?? [])
        .filter((event: any) => {
          if (canManage) return true;
          if (clientView) return event.audience === 'client';
          if (isRole(actor, 5)) return event.audience === 'accounting';
          return event.audience === 'photographer' || event.action === 'photographer.assign';
        })
        .map((event: any) => ({ action: event.action, message: event.message, at: event.at })),
      memberEntry: clientView || canManage ? { opened: !!workflow?.memberEntry?.opened } : null,
      createdAt: workflow?.createdAt,
      updatedAt: workflow?.updatedAt,
    },
  };
};

const readBooking = async (id: string, actor: Actor) => {
  if (!isValidObjectId(id)) throw new WorkflowProblem(404, 'Không tìm thấy booking');
  const booking = await Booking.findById(id).lean();
  if (!booking) throw new WorkflowProblem(404, 'Không tìm thấy booking');
  if (!owner(booking, actor) && !admin(actor)) return booking;
  return booking;
};

export const getWorkflow = async (req: Request, res: Response): Promise<void> => {
  try {
    const booking = await readBooking(req.params.id, req.user!);
    const workflow = (await BookingWorkflow.findOne({ booking: booking._id })
      .select('+memberEntry.tokenHash')
      .lean()) as IBookingWorkflow | null;
    sendResponse(res, 200, true, 'OK', await toDto(booking, workflow, req.user!));
  } catch (error) {
    const problem = error as WorkflowProblem;
    sendResponse(res, problem.status ?? 500, false, problem.message ?? 'Internal server error');
  }
};

export const listWorkflows = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = req.user!;
    const view = req.query.view;
    if (
      view !== undefined &&
      (typeof view !== 'string' || !['active', 'completed', 'cancelled', 'rejected'].includes(view))
    ) {
      throw new WorkflowProblem(400, 'Trạng thái lọc không hợp lệ');
    }
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100_000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new WorkflowProblem(400, 'Thông tin phân trang không hợp lệ');
    }
    const canSeeAll = admin(actor) || isRole(actor, 5);
    let bookingFilter: Record<string, unknown> = {};
    if (!canSeeAll) {
      const clauses: Record<string, unknown>[] = [];
      if (isRole(actor, 6)) clauses.push({ client: actor._id });
      if (isRole(actor, 3)) {
        const assigned = await BookingWorkflow.find({
          $or: [
            { 'resources.photographers': actor._id },
            { assignedPhotographer: actor._id },
            { assignedSupportPhotographers: actor._id },
          ],
        }).distinct('booking');
        clauses.push({ _id: { $in: assigned } });
      }
      if (!clauses.length) throw new WorkflowProblem(403, 'Forbidden: insufficient role');
      bookingFilter = { $or: clauses };
    }
    if (view === 'rejected') bookingFilter.status = 'rejected';
    else if (view) {
      const closed = await BookingWorkflow.find({
        lifecycle: view === 'active' ? { $in: ['completed', 'cancelled'] } : view,
      }).distinct('booking');
      bookingFilter._id = view === 'active' ? { $nin: closed } : { $in: closed };
      if (view === 'active') bookingFilter.status = { $ne: 'rejected' };
    }
    const [bookings, total] = await Promise.all([
      Booking.find(bookingFilter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Booking.countDocuments(bookingFilter),
    ]);
    const ids = bookings.map((booking: any) => booking._id);
    const workflows = await BookingWorkflow.find({ booking: { $in: ids } }).lean();
    const assignments = await workflowPhotographers(workflows);
    const byBooking = new Map(
      workflows.map((workflow: any) => [String(workflow.booking), workflow]),
    );
    const data = bookings.map((booking: any) => {
      const workflow: any = byBooking.get(String(booking._id));
      const payable = workflow ? currentPayable(workflow as unknown as IBookingWorkflow) : 0;
      const net = workflow ? netReceived(workflow as unknown as IBookingWorkflow) : 0;
      const financialView = canSeeAll || owner(booking, actor);
      return {
        bookingId: String(booking._id),
        version: workflow?.version ?? 0,
        lifecycle: workflow?.lifecycle ?? 'intake',
        assignedPhotographer: assignments.get(String(booking._id))?.assignedPhotographer ?? null,
        assignedSupportPhotographers:
          assignments.get(String(booking._id))?.assignedSupportPhotographers ?? [],
        packageName: booking.packageName,
        className: booking.className,
        school: booking.school,
        startTime: workflow?.quote?.proposedSchedule?.startTime,
        shootDate: workflow?.quote?.proposedSchedule?.shootDate ?? booking.startAt,
        updatedAt: workflow?.updatedAt ?? booking.updatedAt,
        bookingStatus: booking.status,
        progressStatus: workflow?.progress?.status,
        ...(financialView
          ? {
              payment: {
                netReceived: net,
                totalDue: Math.max(0, payable - net),
                refundDue: isAppliedFinancialChange(workflow ?? ({} as IBookingWorkflow))
                  ? Math.max(0, net - payable)
                  : 0,
              },
            }
          : {}),
      };
    });
    sendResponse(res, 200, true, 'OK', data, { total, page, limit });
  } catch (error) {
    const problem = error as WorkflowProblem;
    sendResponse(res, problem.status ?? 500, false, problem.message ?? 'Internal server error');
  }
};

const requireActor = (condition: boolean, message = 'Forbidden: insufficient role'): void => {
  if (!condition) throw new WorkflowProblem(403, message);
};

const validateQuote = (input: any, actor: Actor) => {
  if (!input || !Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 30) {
    throw new WorkflowProblem(400, 'Quote needs between 1 and 30 line items');
  }
  const lines = input.lines.map((line: any) => {
    const label = cleanText(line?.label, 160);
    const quantity = Number(line?.quantity);
    const unitPrice = Number(line?.unitPrice);
    if (
      !label ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 10000 ||
      !Number.isSafeInteger(unitPrice) ||
      unitPrice < 0
    ) {
      throw new WorkflowProblem(400, 'Quote line items have invalid labels, quantities, or prices');
    }
    return { label, quantity, unitPrice };
  });
  const total = lines.reduce((sum: number, line: any) => sum + line.quantity * line.unitPrice, 0);
  if (!Number.isSafeInteger(total) || total > 1_000_000_000_000)
    throw new WorkflowProblem(400, 'Tổng báo giá vượt giới hạn cho phép');
  const depositRequired = Number(input.depositRequired);
  const shootDate = new Date(input.proposedSchedule?.shootDate ?? NaN);
  const startTime = input.proposedSchedule?.startTime;
  const endTime = input.proposedSchedule?.endTime;
  const start = parseTime(startTime);
  const end = parseTime(endTime);
  const location = cleanText(input.proposedSchedule?.location, 300);
  const deliveryDays = Number(input.delivery?.targetDays);
  if (
    !Number.isSafeInteger(depositRequired) ||
    depositRequired < 1 ||
    depositRequired > total ||
    !Number.isFinite(shootDate.getTime()) ||
    dayStart(shootDate).getTime() < dayStart(new Date()).getTime() ||
    start === null ||
    end === null ||
    end <= start ||
    !location ||
    !Number.isSafeInteger(deliveryDays) ||
    deliveryDays < 1 ||
    deliveryDays > 365 ||
    !Array.isArray(input.terms) ||
    input.terms.length > 30 ||
    !Array.isArray(input.editingTerms) ||
    input.editingTerms.length > 30
  ) {
    throw new WorkflowProblem(
      400,
      'Quote requires a future schedule, deposit, delivery target, and valid terms',
    );
  }
  const terms = input.terms.map((text: unknown) => cleanText(text, 1000)).filter(Boolean);
  const editingTerms = input.editingTerms
    .map((text: unknown) => cleanText(text, 1000))
    .filter(Boolean);
  if (terms.length !== input.terms.length || editingTerms.length !== input.editingTerms.length) {
    throw new WorkflowProblem(400, 'Quote terms must be non-empty text up to 1000 characters');
  }
  const instructions = paymentReadiness().paymentInstructions;
  return {
    currency: input.currency === 'VND' ? 'VND' : 'VND',
    lines,
    depositRequired,
    proposedSchedule: { shootDate: dayStart(shootDate), startTime, endTime, location },
    delivery: {
      targetDays: deliveryDays,
      targetDate: new Date(dayStart(shootDate).getTime() + deliveryDays * 86400000),
    },
    editingTerms,
    terms,
    paymentInstructions: instructions,
    proposedBy: actor._id,
    proposedAt: new Date(),
  };
};

const parseCostumeReservations = (
  value: unknown,
  _booking: any,
  workflow: IBookingWorkflow,
  shootDate: Date | string = workflow.quote!.proposedSchedule.shootDate,
) => {
  if (!Array.isArray(value) || value.length > 100)
    throw new WorkflowProblem(400, 'Danh sách trang phục không hợp lệ');
  const seen = new Set<string>();
  return value.map((item: any) => {
    if (!isValidObjectId(item?.costumeId))
      throw new WorkflowProblem(400, 'Mã trang phục không hợp lệ');
    const size = cleanText(item.size, 12);
    const quantity = Number(item.quantity);
    const receiveDate = dayStart(new Date(item.receiveDate));
    const returnDate = dayStart(new Date(item.returnDate));
    if (
      !size ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 10000 ||
      !Number.isFinite(receiveDate.getTime()) ||
      !Number.isFinite(returnDate.getTime()) ||
      receiveDate > returnDate ||
      returnDate.getTime() - receiveDate.getTime() > 365 * 86400000
    ) {
      throw new WorkflowProblem(
        400,
        'Ngày nhận, ngày trả, kích cỡ hoặc số lượng trang phục không hợp lệ',
      );
    }
    const key = `${item.costumeId}:${size}`;
    if (seen.has(key))
      throw new WorkflowProblem(400, 'Mỗi trang phục và kích cỡ chỉ được khai báo một lần');
    seen.add(key);
    const shootDay = dayStart(shootDate);
    if (receiveDate > shootDay || returnDate < shootDay)
      throw new WorkflowProblem(400, 'Ngày nhận và trả trang phục phải bao gồm ngày chụp');
    return {
      costumeId: new Types.ObjectId(item.costumeId),
      size,
      quantity,
      receiveDate,
      returnDate,
    };
  });
};
const validateResources = async (
  booking: any,
  proposed: any,
  costumes: Array<Record<string, any>>,
  session: ClientSession,
  excludeSchedule?: Types.ObjectId,
) => {
  const requestedPhotographers = Array.isArray(proposed.photographerIds)
    ? proposed.photographerIds
    : [proposed.leadPhotographer, ...(proposed.supportPhotographers ?? [])];
  if (
    requestedPhotographers.length < 1 ||
    requestedPhotographers.length > 10 ||
    requestedPhotographers.some((id: unknown) => !isValidObjectId(id))
  ) {
    throw new WorkflowProblem(400, 'Cần phân công ít nhất một thợ chụp hợp lệ');
  }
  const photographerIds: string[] = Array.from(
    new Set<string>(requestedPhotographers.map((id: unknown) => String(id))),
  );
  if (photographerIds.length !== requestedPhotographers.length)
    throw new WorkflowProblem(400, 'Danh sách thợ chụp bị trùng');
  const start = parseTime(proposed.startTime);
  const end = parseTime(proposed.endTime);
  if (start === null || end === null || end <= start)
    throw new WorkflowProblem(400, 'Khung giờ chụp không hợp lệ');
  const shootDate = dayStart(new Date(proposed.shootDate));
  if (!Number.isFinite(shootDate.getTime()))
    throw new WorkflowProblem(400, 'Ngày chụp không hợp lệ');
  const location = cleanText(proposed.location, 300);
  if (!location) throw new WorkflowProblem(400, 'Địa điểm chụp là bắt buộc');

  await ensurePhotographersAvailable(
    photographerIds,
    scheduleInterval({ shootDate, startTime: proposed.startTime, endTime: proposed.endTime })!,
    session,
    excludeSchedule,
  );

  const seen = new Set<string>();
  for (const item of costumes) {
    const costumeId = String(item.costumeId);
    const key = `${costumeId}:${item.size}`;
    if (seen.has(key))
      throw new WorkflowProblem(400, 'Mỗi trang phục và kích cỡ chỉ được khai báo một lần');
    seen.add(key);
    const costume = await Costume.findById(costumeId).session(session).lean();
    if (!costume) throw new WorkflowProblem(409, 'Một trang phục đã bị xóa hoặc không còn tồn tại');
    const allowedTypes = (booking.packageSnapshot?.costumeIds ?? []).map(String);
    if (!costume.type || !allowedTypes.includes(String(costume.type))) {
      throw new WorkflowProblem(400, 'Trang phục không thuộc loại trang phục của gói dịch vụ');
    }
    const good = (costume.inventory ?? [])
      .filter((entry: any) => entry.size === item.size && entry.condition === 'good')
      .reduce((sum: number, entry: any) => sum + entry.quantity, 0);
    if (good < item.quantity)
      throw new WorkflowProblem(
        409,
        `Không đủ trang phục tình trạng tốt cỡ ${item.size}: ${costume.name}`,
      );

    const reservations = (await Schedule.find({
      status: { $in: ['pending', 'confirmed', 'completed'] },
      costumes: costumeId,
      ...(excludeSchedule ? { _id: { $ne: excludeSchedule } } : {}),
    })
      .session(session)
      .lean()) as any[];
    const rentals = await rentalReservations(costumeId, session, undefined, String(booking._id));
    for (let day = item.receiveDate.getTime(); day <= item.returnDate.getTime(); day += 86400000) {
      const date = new Date(day);
      let used = rentalUsed(rentals, costumeId, item.size, date);
      for (const row of reservations) {
        const forCostume = (row.costumeReservations ?? []).filter(
          (entry: any) => String(entry.costume) === costumeId,
        );
        if (forCostume.length) {
          used += forCostume
            .filter(
              (entry: any) =>
                entry.size === item.size &&
                dayStart(entry.receiveDate) <= date &&
                dayStart(entry.returnDate) >= date,
            )
            .reduce((sum: number, entry: any) => sum + entry.quantity, 0);
        } else if (dayStart(row.shootDate).getTime() === date.getTime()) {
          // Old schedules have no size/quantity breakdown, so hold the full style for that day.
          throw new WorkflowProblem(
            409,
            `Lịch cũ chưa đối soát kích cỡ trang phục: ${costume.name}`,
          );
        }
      }
      if (used + item.quantity > good)
        throw new WorkflowProblem(
          409,
          `Không đủ số lượng còn trống cỡ ${item.size}: ${costume.name}`,
        );
    }
  }
  return {
    shootDate,
    startTime: proposed.startTime,
    endTime: proposed.endTime,
    location,
    photographerIds,
  };
};
const ensureWorkflow = (booking: any, workflow: IBookingWorkflow | null): IBookingWorkflow =>
  workflow ??
  new BookingWorkflow({
    booking: booking._id,
    lifecycle: 'intake',
    version: 0,
    resources: { photographers: [], costumes: [] },
    members: [],
    payments: [],
    progress: { status: 'not_started', deliveryVersion: 0, revisionRequests: [] },
    events: [],
    idempotency: [],
  });

const currentTotal = (workflow: IBookingWorkflow) => quoteTotal(workflow);
const currentPayable = (workflow: IBookingWorkflow): number =>
  isAppliedFinancialChange(workflow) && Number.isSafeInteger(workflow.changeRequest?.finalPayable)
    ? workflow.changeRequest!.finalPayable
    : quoteTotal(workflow);

const logEvent = (
  workflow: IBookingWorkflow,
  actor: Actor,
  action: string,
  message: string,
  audience = 'client',
) => {
  workflow.events.push({ action, message, actor: actor._id, audience, at: new Date() });
  if (workflow.events.length > 200) workflow.events.splice(0, workflow.events.length - 200);
};

const createLinkedCustomer = async (
  booking: any,
  workflow: IBookingWorkflow,
  session: ClientSession,
) => {
  if (workflow.customer) return;
  const members = workflow.members;
  const totalMale = members.filter((member: any) => member.gender === 'male').length;
  const totalFemale = members.filter((member: any) => member.gender === 'female').length;
  const [customer] = await Customer.create(
    [
      {
        className: booking.className || `${booking.contactName} - ${booking.packageName}`,
        school: booking.school || '',
        contactName: booking.contactName,
        contactPhone: booking.phone,
        contactAddress: booking.location,
        total: members.length,
        totalMale,
        totalFemale,
        notes: booking.note,
        createdBy: booking.client,
      },
    ],
    { session },
  );
  const ids: Types.ObjectId[] = [];
  for (const member of members as any[]) {
    const [student] = await Student.create(
      [
        {
          customer: customer._id,
          name: member.name,
          gender: member.gender,
          height: member.height,
          weight: member.weight,
          notes: member.contact ? `Contact: ${member.contact}` : undefined,
          costumes: member.costumeSizes.map((item: any) => item.costumeId),
          costumeSizes: member.costumeSizes.map((item: any) => ({
            costume: item.costumeId,
            size: item.size,
          })),
        },
      ],
      { session },
    );
    member.student = student._id;
    ids.push(student._id);
  }
  workflow.customer = customer._id;
};

const applyScheduleChange = async (
  booking: any,
  workflow: IBookingWorkflow,
  proposed: any,
  actor: Actor,
  session: ClientSession,
) => {
  const scheduleId = workflow.resources.schedule;
  if (!scheduleId) throw new WorkflowProblem(409, 'Schedule is not confirmed yet');
  const oldShootDay = dayStart(workflow.quote!.proposedSchedule.shootDate);
  const newShootDay = dayStart(proposed.schedule?.shootDate);
  const dayShift = Math.round((newShootDay.getTime() - oldShootDay.getTime()) / 86400000);
  const shiftedCostumes = workflow.resources.costumes.map((item: any) => ({
    costumeId: String(item.costumeId),
    size: item.size,
    quantity: item.quantity,
    receiveDate: new Date(dayStart(item.receiveDate).getTime() + dayShift * 86400000),
    returnDate: new Date(dayStart(item.returnDate).getTime() + dayShift * 86400000),
  }));
  const costumes = parseCostumeReservations(
    proposed.costumes ?? shiftedCostumes,
    booking,
    workflow,
    proposed.schedule?.shootDate,
  );
  const values = await validateResources(
    booking,
    {
      ...proposed.schedule,
      photographerIds:
        proposed.schedule?.photographerIds ?? workflow.resources.photographers.map(String),
    },
    costumes,
    session,
    scheduleId as Types.ObjectId,
  );
  const schedule = await Schedule.findById(String(scheduleId)).session(session);
  if (!schedule) throw new WorkflowProblem(409, 'Linked schedule no longer exists');
  const primary = workflow.assignedPhotographer ?? schedule.leadPhotographer;
  if (primary && String(primary) !== values.photographerIds[0])
    throw new WorkflowProblem(
      409,
      'Đổi thợ phụ trách bằng chức năng phân công trước khi đề xuất đổi lịch.',
    );
  schedule.shootDate = values.shootDate;
  schedule.startTime = values.startTime;
  schedule.endTime = values.endTime;
  schedule.location = values.location;
  schedule.leadPhotographer = new Types.ObjectId(values.photographerIds[0]);
  schedule.supportPhotographers = values.photographerIds
    .slice(1)
    .map((id: string) => new Types.ObjectId(id));
  schedule.costumes = costumes.map((item: any) => item.costumeId);
  schedule.costumeReservations = costumes.map((item: any) => ({
    costume: item.costumeId,
    size: item.size,
    quantity: item.quantity,
    receiveDate: item.receiveDate,
    returnDate: item.returnDate,
  }));
  await schedule.save({ session });
  workflow.resources.photographers = values.photographerIds.map(
    (id: string) => new Types.ObjectId(id),
  ) as any;
  workflow.assignedSupportPhotographers = values.photographerIds
    .slice(1)
    .map((id: string) => new Types.ObjectId(id));
  workflow.resources.costumes = costumes as any;
};

const amendAcceptedQuote = (workflow: IBookingWorkflow, request: any, actor: Actor): void => {
  if (!workflow.quote || !Number.isSafeInteger(request.finalPayable))
    throw new WorkflowProblem(409, 'A finalized contract amount is required');
  workflow.quoteHistory.push(workflow.quote.toObject() as any);
  const next: any = workflow.quote.toObject();
  next.version += 1;
  next.lines = [
    {
      label: `Total under accepted change ${String(request._id).slice(-6)}`,
      quantity: 1,
      unitPrice: request.finalPayable,
    },
  ];
  next.depositRequired = Math.min(next.depositRequired, request.finalPayable);
  next.terms = [...new Set([...(next.terms ?? []), ...(request.terms ?? [])])];
  if (request.proposed?.schedule) {
    const schedule = request.proposed.schedule;
    next.proposedSchedule = {
      shootDate: dayStart(new Date(schedule.shootDate)),
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      location: schedule.location,
    };
  }
  next.proposedBy = actor._id;
  next.proposedAt = request.proposedAt ?? new Date();
  next.acceptedBy = request.acceptedBy;
  next.acceptedAt = request.acceptedAt ?? new Date();
  workflow.quote = next as any;
};

const runAction = async (
  bookingId: string,
  actor: Actor,
  body: ActionBody,
  idempotencyKey: string,
) => {
  const action = body.action;
  if (typeof action !== 'string') throw new WorkflowProblem(400, 'Action is required');
  const actionFingerprint = hash({ ...body, expectedVersion: undefined });
  let memberToken: string | undefined;
  let changed = false;
  let bookingResult: any;
  let workflowResult: IBookingWorkflow | null = null;

  await withResourceTransaction(async (session) => {
    if (!isValidObjectId(bookingId)) throw new WorkflowProblem(404, 'Không tìm thấy booking');
    const booking = await Booking.findById(bookingId).session(session);
    if (!booking) throw new WorkflowProblem(404, 'Không tìm thấy booking');
    const isOwner = owner(booking, actor);
    const isAdmin = admin(actor);
    let workflow = await BookingWorkflow.findOne({ booking: booking._id })
      .select('+memberEntry.tokenHash')
      .session(session);
    const scopedKey = `${actor._id}:${idempotencyKey}`;
    const canUseAction =
      isAdmin ||
      (isOwner &&
        [
          'quote.accept',
          'revision.request',
          'delivery.accept',
          'feedback.submit',
          'change.request',
          'change.accept',
          'change.decline',
          'change.withdraw',
          'member-link.open',
          'member-link.close',
        ].includes(action)) ||
      (action === 'payment.record' && isRole(actor, 5)) ||
      (action === 'progress.update' &&
        isRole(actor, 3) &&
        !!workflow?.resources.photographers.some((id: any) => String(id) === String(actor._id)));
    requireActor(canUseAction);
    const alreadyDone = workflow?.idempotency.find((entry: any) => entry.key === scopedKey);
    if (alreadyDone) {
      if (alreadyDone.fingerprint !== actionFingerprint)
        throw new WorkflowProblem(409, 'Idempotency key was already used for a different action');
      bookingResult = booking.toObject();
      workflowResult = workflow;
      return;
    }
    if (
      !Number.isSafeInteger(body.expectedVersion) ||
      body.expectedVersion !== (workflow?.version ?? 0)
    ) {
      throw new WorkflowProblem(
        409,
        'Workflow changed. Refresh and retry with the current version.',
      );
    }
    workflow = ensureWorkflow(booking, workflow);
    const requireOwner = () => requireActor(isOwner, 'Only the booking owner can do this');
    const requireAdmin = () => requireActor(isAdmin);
    const requireApproved = () =>
      requireActor(
        booking.status === 'approved',
        'The studio must approve this intake before quoting',
      );
    const parsedProposed = (input: any) => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new WorkflowProblem(400, 'Proposed change is required');
      return input;
    };

    switch (action) {
      case 'photographer.assign': {
        requireAdmin();
        if (
          booking.status === 'rejected' ||
          !['intake', 'quoting', 'awaiting_deposit', 'ready_to_confirm', 'confirmed'].includes(
            workflow.lifecycle,
          ) ||
          (workflow.changeRequest &&
            ['requested', 'proposed', 'accepted'].includes(workflow.changeRequest.status))
        )
          throw new WorkflowProblem(
            409,
            'Chỉ đổi phân công trước khi chụp và khi không có đề xuất thay đổi đang xử lý.',
          );
        const linked = workflow.resources.schedule
          ? await Schedule.findById(workflow.resources.schedule).session(session)
          : null;
        if (workflow.resources.schedule && !linked)
          throw new WorkflowProblem(409, 'Không tìm thấy lịch đã liên kết.');
        if (linked && !['pending', 'confirmed'].includes(linked.status))
          throw new WorkflowProblem(409, 'Lịch đã kết thúc hoặc hủy, không thể đổi thợ.');
        const range = linked
          ? scheduleInterval(linked)
          : workflow.quote
            ? scheduleInterval(workflow.quote.proposedSchedule as any)
            : { start: booking.startAt.getTime(), end: booking.endAt.getTime() };
        if (!range) throw new WorkflowProblem(409, 'Cần khung giờ hợp lệ trước khi phân công.');
        const explicitTeam = Object.prototype.hasOwnProperty.call(body, 'photographerIds');
        const requested = explicitTeam ? body.photographerIds : [body.photographerId];
        if (
          !Array.isArray(requested) ||
          requested.length < 1 ||
          requested.length > 10 ||
          requested.some((id: unknown) => typeof id !== 'string' || !isValidObjectId(id)) ||
          new Set(requested).size !== requested.length
        )
          throw new WorkflowProblem(
            400,
            'Chọn từ 1 đến 10 thợ hợp lệ, không trùng nhau. Thợ đầu tiên là thợ chính.',
          );
        const nextId: string = requested[0];
        const supports: string[] = explicitTeam
          ? requested.slice(1)
          : (linked?.supportPhotographers ?? workflow.assignedSupportPhotographers ?? [])
              .map(String)
              .filter((id: string) => id !== nextId);
        await ensurePhotographersAvailable(
          [nextId, ...supports],
          range,
          session,
          linked?._id as Types.ObjectId | undefined,
        );
        workflow.assignedPhotographer = new Types.ObjectId(nextId);
        workflow.assignedSupportPhotographers = supports.map((id) => new Types.ObjectId(id));
        // Also conflict with concurrent intake rejection and refresh the intake list ordering.
        booking.updatedAt = new Date();
        await booking.save({ session });
        if (linked) {
          linked.leadPhotographer = new Types.ObjectId(nextId);
          linked.supportPhotographers = supports.map((id) => new Types.ObjectId(id));
          await linked.save({ session });
          workflow.resources.photographers = [nextId, ...supports].map(
            (id) => new Types.ObjectId(id),
          );
        }
        const person = await User.findById(nextId).select('name username').session(session).lean();
        const supportPeople = await User.find({ _id: { $in: supports } })
          .select('name username')
          .session(session)
          .lean();
        const message = `Thợ phụ trách: ${person?.name || person?.username}. Thợ hỗ trợ: ${supportPeople.map((row) => row.name || row.username).join(', ') || 'Không có'}. ${linked ? 'Đã cập nhật ekip của lịch.' : 'Chưa giữ khung giờ chụp.'}`;
        logEvent(workflow, actor, action, message, 'client');
        break;
      }
      case 'quote.propose': {
        requireAdmin();
        requireApproved();
        if (workflow.payments.length || workflow.quote?.acceptedAt)
          throw new WorkflowProblem(
            409,
            'Use a client-approved change request after quote acceptance or payments have started',
          );
        if (workflow.quote) workflow.quoteHistory.push(workflow.quote.toObject() as any);
        workflow.quote = {
          ...validateQuote(body.quote, actor),
          version: (workflow.quote?.version ?? 0) + 1,
        } as any;
        workflow.lifecycle = 'quoting';
        workflow.progress.status = 'not_started';
        workflow.progress.acceptedAt = undefined;
        logEvent(
          workflow,
          actor,
          action,
          'Studio prepared a versioned quote and schedule proposal.',
          'client',
        );
        break;
      }
      case 'quote.accept': {
        requireOwner();
        if (booking.status !== 'approved' || !workflow.quote || workflow.quote.acceptedAt)
          throw new WorkflowProblem(409, 'There is no current quote to accept');
        workflow.quote.acceptedAt = new Date();
        workflow.quote.acceptedBy = actor._id as any;
        workflow.lifecycle = 'awaiting_deposit';
        logEvent(
          workflow,
          actor,
          action,
          `Accepted quote version ${workflow.quote.version}.`,
          'admin',
        );
        break;
      }
      case 'payment.record': {
        requireActor(isAdmin || isRole(actor, 5));
        const cancellation =
          workflow.lifecycle === 'cancelled' &&
          workflow.changeRequest?.kind === 'cancel' &&
          workflow.changeRequest.status === 'applied';
        const finalizedChange = isAppliedFinancialChange(workflow);
        if (
          !workflow.quote?.acceptedAt ||
          (!cancellation &&
            ![
              'awaiting_deposit',
              'ready_to_confirm',
              'confirmed',
              'shooting',
              'editing',
              'delivered',
              'revision_requested',
              'accepted',
            ].includes(workflow.lifecycle))
        )
          throw new WorkflowProblem(
            409,
            'A client-accepted quote is required before recording money',
          );
        const kind = body.kind;
        const amount = Number(body.amount);
        const method = body.method;
        const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
        if (
          !['deposit', 'balance', 'refund'].includes(kind) ||
          !Number.isSafeInteger(amount) ||
          amount < 1 ||
          amount > 100_000_000_000 ||
          !['cash', 'bank_transfer', 'other'].includes(method) ||
          !Number.isFinite(receivedAt.getTime()) ||
          receivedAt.getTime() > Date.now() + 300000
        )
          throw new WorkflowProblem(400, 'Payment fields are invalid');
        const net = netReceived(workflow);
        if (
          kind === 'deposit' &&
          (workflow.lifecycle !== 'awaiting_deposit' ||
            net >= workflow.quote.depositRequired ||
            amount > workflow.quote.depositRequired - net)
        )
          throw new WorkflowProblem(409, 'Deposit amount must cover only the outstanding deposit');
        if (
          kind === 'balance' &&
          (cancellation
            ? amount > Math.max(0, (workflow.changeRequest?.finalPayable ?? 0) - net)
            : net < workflow.quote.depositRequired ||
              !workflow.resources.schedule ||
              amount > currentTotal(workflow) - net)
        )
          throw new WorkflowProblem(
            409,
            'Balance payment cannot exceed the outstanding agreed amount',
          );
        if (
          kind === 'refund' &&
          (!finalizedChange ||
            amount >
              Math.max(0, net - (workflow.changeRequest?.finalPayable ?? quoteTotal(workflow))))
        )
          throw new WorkflowProblem(
            409,
            'Refunds are available only after a client-approved change or cancellation and cannot exceed the amount due back',
          );
        const type = kind === 'refund' ? 'expense' : 'income';
        const categoryName =
          kind === 'deposit' ? 'Đặt cọc' : kind === 'refund' ? 'Hoàn tiền' : 'Thanh toán còn lại';
        let category = await Category.findOne({ name: categoryName, type }).session(session);
        if (!category)
          [category] = await Category.create(
            [{ name: categoryName, type, isDefault: true, createdBy: actor._id }],
            { session },
          );
        const paymentId = new Types.ObjectId();
        const description = `${kind === 'refund' ? 'Refund' : kind === 'deposit' ? 'Deposit' : 'Balance payment'} for booking ${booking._id}${body.reference ? ` (${String(body.reference).slice(0, 100)})` : ''}`;
        const [transaction] = await Transaction.create(
          [
            {
              customer: workflow.customer ?? null,
              workflowBooking: booking._id,
              workflowPayment: paymentId,
              type,
              amount,
              categoryId: category._id,
              description,
              date: receivedAt,
              createdBy: actor._id,
            },
          ],
          { session },
        );
        workflow.payments.push({
          _id: paymentId,
          kind,
          amount,
          method,
          reference: cleanText(body.reference, 120, false),
          receivedAt,
          transaction: transaction._id,
          recordedBy: actor._id,
        });
        if (
          !cancellation &&
          netReceived(workflow) >= workflow.quote.depositRequired &&
          !workflow.resources.schedule
        )
          workflow.lifecycle = 'ready_to_confirm';
        if (
          !cancellation &&
          workflow.resources.schedule &&
          settled(workflow) &&
          workflow.progress.acceptedAt
        )
          workflow.lifecycle = 'completed';
        logEvent(workflow, actor, action, `${kind} of ${amount} recorded.`, 'accounting');
        break;
      }
      case 'resources.confirm': {
        requireAdmin();
        if (
          !workflow.quote?.acceptedAt ||
          netReceived(workflow) < workflow.quote.depositRequired ||
          workflow.resources.schedule ||
          !['ready_to_confirm', 'awaiting_deposit'].includes(workflow.lifecycle)
        )
          throw new WorkflowProblem(
            409,
            'Client acceptance and the required net deposit are needed before confirming resources',
          );
        if (workflow.members.length !== booking.members)
          throw new WorkflowProblem(
            409,
            `Member intake is incomplete: ${workflow.members.length} of ${booking.members} members`,
          );
        const requestedSchedule = body.schedule ?? workflow.quote.proposedSchedule;
        if (
          dayStart(new Date(requestedSchedule.shootDate)).getTime() !==
            dayStart(workflow.quote.proposedSchedule.shootDate).getTime() ||
          requestedSchedule.startTime !== workflow.quote.proposedSchedule.startTime ||
          requestedSchedule.endTime !== workflow.quote.proposedSchedule.endTime ||
          requestedSchedule.location !== workflow.quote.proposedSchedule.location
        )
          throw new WorkflowProblem(
            409,
            'Schedule differs from the client-accepted quote; use the change request flow',
          );
        const costumes = parseCostumeReservations(body.costumes ?? [], booking, workflow);
        const resourceValues = await validateResources(
          booking,
          {
            ...requestedSchedule,
            photographerIds: requestedSchedule.photographerIds ?? [
              requestedSchedule.leadPhotographer,
              ...(requestedSchedule.supportPhotographers ?? []),
            ],
          },
          costumes,
          session,
        );
        if (
          workflow.assignedPhotographer &&
          String(workflow.assignedPhotographer) !== resourceValues.photographerIds[0]
        )
          throw new WorkflowProblem(
            409,
            'Thợ phụ trách phải là thợ chính. Hãy cập nhật phân công trước khi xác nhận.',
          );
        workflow.assignedPhotographer = new Types.ObjectId(resourceValues.photographerIds[0]);
        workflow.assignedSupportPhotographers = resourceValues.photographerIds
          .slice(1)
          .map((id: string) => new Types.ObjectId(id));
        await createLinkedCustomer(booking, workflow, session);
        const [schedule] = await Schedule.create(
          [
            {
              customer: workflow.customer,
              package: booking.package,
              costumes: costumes.map((item: any) => item.costumeId),
              costumeReservations: costumes.map((item: any) => ({
                costume: item.costumeId,
                size: item.size,
                quantity: item.quantity,
                receiveDate: item.receiveDate,
                returnDate: item.returnDate,
              })),
              shootDate: resourceValues.shootDate,
              startTime: resourceValues.startTime,
              endTime: resourceValues.endTime,
              location: resourceValues.location,
              leadPhotographer: new Types.ObjectId(String(resourceValues.photographerIds[0])),
              supportPhotographers: resourceValues.photographerIds
                .slice(1)
                .map((id: string) => new Types.ObjectId(String(id))),
              bookedBy: actor._id,
              status: 'confirmed',
              notes: booking.note,
              workflowBooking: booking._id,
              season: null,
            },
          ],
          { session },
        );
        workflow.resources.schedule = schedule._id;
        if (booking.costumeHold && ['approved', 'temporary'].includes(booking.costumeHold.status)) {
          booking.costumeHold.status = 'transferred';
          await booking.save({ session });
        }
        workflow.resources.photographers = resourceValues.photographerIds.map(
          (id: string) => new Types.ObjectId(String(id)),
        ) as any;
        workflow.resources.costumes = costumes as any;
        workflow.memberEntry.opened = false;
        workflow.memberEntry.closedAt = new Date();
        workflow.lifecycle = 'confirmed';
        logEvent(
          workflow,
          actor,
          action,
          'Studio confirmed the schedule and reserved photographers and costumes.',
          'client',
        );
        break;
      }
      case 'progress.update': {
        requireActor(
          isAdmin ||
            (isRole(actor, 3) &&
              workflow.resources.photographers.some((id: any) => String(id) === String(actor._id))),
          'Only a studio admin or assigned photographer can update progress',
        );
        const nextStatus = body.status;
        const allowed: Record<string, string[]> = {
          confirmed: ['shooting'],
          shooting: ['editing'],
          editing: ['delivered'],
          revision_requested: ['editing'],
        };
        if (!workflow.resources.schedule || !allowed[workflow.lifecycle]?.includes(nextStatus))
          throw new WorkflowProblem(409, 'Progress update does not follow the current lifecycle');
        if (nextStatus === 'shooting') {
          await validateResources(
            booking,
            {
              shootDate: workflow.quote!.proposedSchedule.shootDate,
              startTime: workflow.quote!.proposedSchedule.startTime,
              endTime: workflow.quote!.proposedSchedule.endTime,
              location: workflow.quote!.proposedSchedule.location,
              photographerIds: workflow.resources.photographers.map(String),
            },
            workflow.resources.costumes as any,
            session,
            workflow.resources.schedule as Types.ObjectId,
          );
        }
        workflow.progress.status = nextStatus;
        if (nextStatus === 'delivered') {
          const deliveryUrl = safeUrl(body.deliveryUrl);
          if (!deliveryUrl) throw new WorkflowProblem(400, 'Delivery must be an http(s) URL');
          workflow.progress.deliveryUrl = deliveryUrl;
          workflow.progress.deliveryVersion += 1;
          workflow.progress.deliveredAt = new Date();
          workflow.deliveryHistory.push({
            version: workflow.progress.deliveryVersion,
            deliveryUrl,
            deliveredAt: workflow.progress.deliveredAt,
            deliveredBy: actor._id,
          } as any);
          const unresolved = workflow.progress.revisionRequests.find(
            (item: any) => !item.resolvedAt,
          );
          if (unresolved) unresolved.resolvedAt = new Date();
        }
        workflow.lifecycle = nextStatus;
        logEvent(
          workflow,
          actor,
          action,
          nextStatus === 'delivered'
            ? 'Updated delivery link.'
            : `Updated progress to ${nextStatus}.`,
          'client',
        );
        break;
      }
      case 'revision.request': {
        requireOwner();
        const note = cleanText(body.note, 2000);
        if (
          !note ||
          workflow.lifecycle !== 'delivered' ||
          workflow.progress.status !== 'delivered' ||
          body.deliveryVersion !== workflow.progress.deliveryVersion
        )
          throw new WorkflowProblem(
            409,
            'Revisions can be requested only against the current delivered version',
          );
        workflow.progress.revisionRequests.push({
          note,
          deliveryVersion: workflow.progress.deliveryVersion,
          requestedBy: actor._id,
          at: new Date(),
        } as any);
        workflow.progress.acceptedAt = undefined;
        workflow.progress.acceptedDeliveryVersion = undefined;
        workflow.lifecycle = 'revision_requested';
        logEvent(workflow, actor, action, 'Client requested a revision.', 'admin');
        break;
      }
      case 'delivery.accept': {
        requireOwner();
        if (
          workflow.lifecycle !== 'delivered' ||
          workflow.progress.status !== 'delivered' ||
          body.deliveryVersion !== workflow.progress.deliveryVersion
        )
          throw new WorkflowProblem(
            409,
            'Delivery version is stale or no current delivery is available',
          );
        workflow.progress.acceptedAt = new Date();
        workflow.progress.acceptedDeliveryVersion = workflow.progress.deliveryVersion;
        workflow.lifecycle = settled(workflow) ? 'completed' : 'accepted';
        logEvent(workflow, actor, action, 'Client accepted the current delivery.', 'admin');
        break;
      }
      case 'feedback.submit': {
        requireOwner();
        const rating = Number(body.rating);
        const comment = cleanText(body.comment ?? '', 2000, false);
        if (
          workflow.lifecycle !== 'completed' ||
          !Number.isInteger(rating) ||
          rating < 1 ||
          rating > 5 ||
          comment === null ||
          workflow.feedback?.rating
        )
          throw new WorkflowProblem(
            409,
            'Feedback requires a completed booking and may be submitted once',
          );
        const [feedback] = await Feedback.create(
          [
            {
              customer: workflow.customer,
              phone: booking.phone,
              workflowBooking: booking._id,
              rating,
              comment,
              isRead: false,
            },
          ],
          { session },
        );
        workflow.feedback = { record: feedback._id, rating, comment, at: new Date() } as any;
        logEvent(workflow, actor, action, 'Client submitted service feedback.', 'admin');
        break;
      }
      case 'change.request': {
        requireOwner();
        const kind = body.kind;
        const note = cleanText(body.note ?? '', 2000, false);
        const activeRequest =
          workflow.changeRequest &&
          ['requested', 'proposed'].includes(workflow.changeRequest.status);
        const changeStages = ['awaiting_deposit', 'ready_to_confirm', 'confirmed'];
        const cancelStages = [
          'awaiting_deposit',
          'ready_to_confirm',
          'confirmed',
          'shooting',
          'editing',
          'delivered',
          'revision_requested',
          'accepted',
        ];
        if (
          !workflow.quote?.acceptedAt ||
          !['change', 'cancel'].includes(kind) ||
          note === null ||
          activeRequest ||
          (kind === 'change' && !changeStages.includes(workflow.lifecycle)) ||
          (kind === 'cancel' && !cancelStages.includes(workflow.lifecycle))
        ) {
          throw new WorkflowProblem(
            409,
            'Yêu cầu thay đổi hoặc hủy không phù hợp với trạng thái hiện tại',
          );
        }
        if (workflow.changeRequest)
          workflow.changeHistory.push(workflow.changeRequest.toObject() as any);
        workflow.changeRequest = {
          kind,
          status: 'requested',
          requested: parsedProposed(body.proposed ?? {}),
          note,
          requestedBy: actor._id,
          previousLifecycle: workflow.lifecycle,
          at: new Date(),
        } as any;
        workflow.lifecycle = 'change_pending';
        logEvent(
          workflow,
          actor,
          action,
          kind === 'cancel'
            ? 'Khách hàng yêu cầu hủy dịch vụ.'
            : 'Khách hàng yêu cầu thay đổi lịch.',
          'admin',
        );
        break;
      }
      case 'change.propose': {
        requireAdmin();
        const request = workflow.changeRequest;
        if (
          !request ||
          String(request._id) !== String(body.requestId) ||
          request.status !== 'requested'
        )
          throw new WorkflowProblem(409, 'Change request is no longer current');
        const proposed = parsedProposed(body.proposed);
        const terms = Array.isArray(body.terms)
          ? body.terms.map((item: unknown) => cleanText(item, 1000))
          : [];
        if (terms.length > 30 || terms.some((item: string | null) => !item))
          throw new WorkflowProblem(400, 'Proposal terms are invalid');
        const finalPayable = Number(body.finalPayable ?? proposed.finalPayable);
        if (
          !Number.isSafeInteger(finalPayable) ||
          finalPayable < 0 ||
          finalPayable > 1_000_000_000_000
        )
          throw new WorkflowProblem(400, 'Khoản phải trả cuối cùng không hợp lệ');
        if (request.kind === 'cancel' && finalPayable > currentTotal(workflow))
          throw new WorkflowProblem(
            400,
            'Khoản thanh toán cuối cùng không thể vượt quá giá trị hợp đồng',
          );
        proposed.finalPayable = finalPayable;
        if (request.kind === 'change') {
          const schedule = proposed.schedule;
          const shootDate = new Date(schedule?.shootDate ?? NaN);
          const startTime = schedule?.startTime;
          const endTime = schedule?.endTime;
          const start = parseTime(startTime);
          const end = parseTime(endTime);
          const location = cleanText(schedule?.location, 300);
          if (
            !Number.isFinite(shootDate.getTime()) ||
            dayStart(shootDate).getTime() < dayStart(new Date()).getTime() ||
            start === null ||
            end === null ||
            end <= start ||
            !location
          ) {
            throw new WorkflowProblem(
              400,
              'Đề xuất thay đổi cần ngày, giờ và địa điểm chụp hợp lệ trong tương lai',
            );
          }
          proposed.schedule = { shootDate: dayStart(shootDate), startTime, endTime, location };
        }
        request.finalPayable = finalPayable;
        request.refundDue = Math.max(0, netReceived(workflow) - finalPayable);
        request.proposed = proposed;
        request.priceDelta = finalPayable - currentTotal(workflow);
        request.terms = terms as any;
        request.proposedBy = actor._id as any;
        request.proposedAt = new Date();
        request.status = 'proposed';
        logEvent(
          workflow,
          actor,
          action,
          'Studio proposed terms for the requested change.',
          'client',
        );
        break;
      }
      case 'change.accept': {
        requireOwner();
        const request = workflow.changeRequest;
        if (
          !request ||
          String(request._id) !== String(body.requestId) ||
          request.status !== 'proposed'
        )
          throw new WorkflowProblem(409, 'There is no current studio proposal to accept');
        request.acceptedBy = actor._id as any;
        request.acceptedAt = new Date();
        if (request.kind === 'cancel') {
          if (workflow.resources.schedule) {
            const released = await Schedule.updateOne(
              {
                _id: workflow.resources.schedule,
                workflowBooking: booking._id,
                status: { $ne: 'cancelled' },
              },
              { $set: { status: 'cancelled' } },
              { session },
            );
            if (released.matchedCount !== 1)
              throw new WorkflowProblem(409, 'Linked schedule could not be released');
          }
          workflow.memberEntry.opened = false;
          workflow.lifecycle = 'cancelled';
          if (booking.costumeHold && booking.costumeHold.status !== 'transferred') {
            booking.costumeHold.status = 'released';
            booking.costumeHold.releasedAt = new Date();
            booking.costumeHold.releaseReason = 'Hủy dịch vụ';
            await booking.save({ session });
          }
        } else {
          if (workflow.resources.schedule)
            await applyScheduleChange(booking, workflow, request.proposed, actor, session);
          amendAcceptedQuote(workflow, request, actor);
          workflow.lifecycle = request.previousLifecycle ?? 'confirmed';
        }
        request.status = 'applied';
        logEvent(
          workflow,
          actor,
          action,
          'Khách hàng chấp nhận đề xuất của studio; thay đổi đã được áp dụng.',
          'admin',
        );
        break;
      }
      case 'change.decline': {
        requireActor(isAdmin || isOwner);
        const request = workflow.changeRequest;
        if (
          !request ||
          String(request._id) !== String(body.requestId) ||
          !['requested', 'proposed'].includes(request.status)
        )
          throw new WorkflowProblem(409, 'Yêu cầu thay đổi không còn chờ xử lý');
        if (!isAdmin && request.status !== 'proposed')
          throw new WorkflowProblem(
            409,
            'Studio must propose terms before the client can decline them',
          );
        request.status = 'declined';
        workflow.lifecycle = request.previousLifecycle ?? 'confirmed';
        logEvent(
          workflow,
          actor,
          action,
          isAdmin ? 'Studio declined the change request.' : 'Client declined the studio proposal.',
          isAdmin ? 'client' : 'admin',
        );
        break;
      }
      case 'change.withdraw': {
        requireOwner();
        const request = workflow.changeRequest;
        if (
          !request ||
          String(request._id) !== String(body.requestId) ||
          !['requested', 'proposed'].includes(request.status)
        )
          throw new WorkflowProblem(409, 'Yêu cầu thay đổi không còn chờ rút lại');
        request.status = 'declined';
        workflow.lifecycle = request.previousLifecycle ?? 'confirmed';
        logEvent(workflow, actor, action, 'Client withdrew the change request.', 'admin');
        break;
      }
      case 'member-link.open': {
        requireActor(
          isOwner || isAdmin,
          'Only the booking owner or studio admin can open member intake',
        );
        if (
          !workflow.quote?.acceptedAt ||
          workflow.resources.schedule ||
          !['awaiting_deposit', 'ready_to_confirm'].includes(workflow.lifecycle)
        )
          throw new WorkflowProblem(
            409,
            'Member intake can be opened after quote acceptance and before confirmation',
          );
        memberToken = crypto.randomBytes(32).toString('base64url');
        workflow.memberEntry = {
          tokenHash: hash(memberToken),
          opened: true,
          openedAt: new Date(),
        } as any;
        logEvent(workflow, actor, action, 'Member intake link opened.', 'client');
        break;
      }
      case 'member-link.close': {
        requireActor(
          isOwner || isAdmin,
          'Only the booking owner or studio admin can close member intake',
        );
        if (!workflow.memberEntry?.opened)
          throw new WorkflowProblem(409, 'Member intake link is already closed');
        workflow.memberEntry.opened = false;
        workflow.memberEntry.closedAt = new Date();
        logEvent(workflow, actor, action, 'Member intake link closed.', 'client');
        break;
      }
      default:
        throw new WorkflowProblem(400, 'Unsupported workflow action');
    }

    workflow.version += 1;
    workflow.idempotency.push({
      key: scopedKey,
      fingerprint: actionFingerprint,
      action,
      at: new Date(),
    } as any);
    await workflow.save({ session });
    changed = true;
    bookingResult = booking.toObject();
    workflowResult = workflow;
  });
  return { booking: bookingResult, workflow: workflowResult, changed, memberToken };
};

export const executeWorkflowAction = async (req: Request, res: Response): Promise<void> => {
  if (!workflowEnabled()) {
    sendResponse(
      res,
      503,
      false,
      'Customer workflow writes are disabled until transactional MongoDB is enabled.',
    );
    return;
  }
  const idempotencyKey = req.get('Idempotency-Key')?.trim() ?? '';
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    sendResponse(res, 400, false, 'Idempotency-Key must be 8 to 128 safe characters');
    return;
  }
  try {
    const result = await runAction(req.params.id, req.user!, req.body ?? {}, idempotencyKey);
    const dto: any = await toDto(result.booking, result.workflow, req.user!);
    if (result.memberToken) {
      dto.workflow.memberEntry = {
        opened: true,
        url: `/api/public/member-intake/${encodeURIComponent(result.memberToken)}`,
        token: result.memberToken,
        expiresAt: null,
      };
    }
    sendResponse(
      res,
      result.changed ? 200 : 200,
      true,
      result.changed ? 'Workflow updated' : 'Action was already recorded',
      dto,
    );
  } catch (error) {
    const problem = error as WorkflowProblem;
    sendResponse(res, problem.status ?? 500, false, problem.message ?? 'Internal server error');
  }
};

export const replaceWorkflowMembers = async (req: Request, res: Response): Promise<void> => {
  if (!workflowEnabled()) {
    sendResponse(
      res,
      503,
      false,
      'Customer workflow writes are disabled until transactional MongoDB is enabled.',
    );
    return;
  }
  const expectedVersion = req.body?.expectedVersion;
  const members = req.body?.members;
  const idempotencyKey = req.get('Idempotency-Key')?.trim();
  if (!Number.isSafeInteger(expectedVersion) || !Array.isArray(members) || members.length > 1000) {
    sendResponse(res, 400, false, 'Roster details or expected version are invalid');
    return;
  }
  if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    sendResponse(res, 400, false, 'Idempotency-Key must be 8 to 128 safe characters');
    return;
  }
  const rosterFingerprint = hash(members);
  try {
    let bookingResult: any;
    let workflowResult: IBookingWorkflow | null = null;
    let changed = false;
    await withResourceTransaction(async (session) => {
      if (!isValidObjectId(req.params.id)) throw new WorkflowProblem(404, 'Không tìm thấy booking');
      const booking = await Booking.findById(req.params.id).session(session);
      if (!booking) throw new WorkflowProblem(404, 'Không tìm thấy booking');
      requireActor(owner(booking, req.user!), 'Only the booking owner can edit the member roster');
      const workflow = await BookingWorkflow.findOne({ booking: booking._id }).session(session);
      if (!workflow) throw new WorkflowProblem(404, 'Workflow is not available');
      const scopedKey = idempotencyKey ? `${req.user!._id}:${idempotencyKey}` : undefined;
      const prior = scopedKey
        ? workflow.idempotency.find((entry: any) => entry.key === scopedKey)
        : undefined;
      if (prior) {
        if (prior.fingerprint !== rosterFingerprint)
          throw new WorkflowProblem(409, 'Idempotency key was already used for a different roster');
        bookingResult = booking.toObject();
        workflowResult = workflow;
        return;
      }
      if (workflow.version !== expectedVersion)
        throw new WorkflowProblem(
          409,
          'Workflow changed. Refresh and retry with the current version.',
        );
      if (
        !workflow.quote?.acceptedAt ||
        workflow.resources.schedule ||
        workflow.memberEntry?.opened ||
        !['awaiting_deposit', 'ready_to_confirm'].includes(workflow.lifecycle)
      ) {
        throw new WorkflowProblem(
          409,
          'Close member intake before editing the roster; edits are available before schedule confirmation.',
        );
      }
      if (members.length > booking.members)
        throw new WorkflowProblem(400, `At most ${booking.members} members can be entered`);
      const allowedTypes = (booking.packageSnapshot?.costumeIds ?? []).map(String);
      const normalized = members.map((item: any) => {
        const name = cleanText(item?.name, 100);
        const contact = cleanText(item?.contact ?? '', 80, false);
        const gender = item?.gender;
        const height =
          item?.height === undefined || item.height === null || item.height === ''
            ? undefined
            : Number(item.height);
        const weight =
          item?.weight === undefined || item.weight === null || item.weight === ''
            ? undefined
            : Number(item.weight);
        const sizes = item?.costumeSizes ?? [];
        if (
          !name ||
          contact === null ||
          !['male', 'female', 'other', undefined].includes(gender) ||
          (height !== undefined && (!Number.isFinite(height) || height < 1 || height > 250)) ||
          (weight !== undefined && (!Number.isFinite(weight) || weight < 1 || weight > 500)) ||
          !Array.isArray(sizes) ||
          sizes.length > 20
        ) {
          throw new WorkflowProblem(400, 'Member details are invalid');
        }
        const seen = new Set<string>();
        const costumeSizes = sizes.map((size: any) => {
          if (
            !isValidObjectId(size?.costumeId) ||
            typeof size.size !== 'string' ||
            !size.size.trim()
          )
            throw new WorkflowProblem(400, 'Costume sizes are invalid');
          const costumeId = String(size.costumeId);
          if (seen.has(costumeId))
            throw new WorkflowProblem(400, 'Each costume can be selected once per member');
          seen.add(costumeId);
          return { costumeId, size: size.size.trim() };
        });
        return { sourceId: item?._id, name, contact, gender, height, weight, costumeSizes };
      });
      const costumeIds = [
        ...new Set(
          normalized.flatMap((member: any) =>
            member.costumeSizes.map((item: any) => item.costumeId),
          ),
        ),
      ];
      const costumes = await Costume.find({ _id: { $in: costumeIds }, type: { $in: allowedTypes } })
        .session(session)
        .lean();
      if (costumes.length !== costumeIds.length)
        throw new WorkflowProblem(400, 'A selected costume is not part of this package');
      for (const member of normalized as any[]) {
        for (const selection of member.costumeSizes) {
          const costume: any = costumes.find(
            (item: any) => String(item._id) === selection.costumeId,
          );
          if (
            !(costume.inventory ?? []).some(
              (item: any) =>
                item.size === selection.size && item.condition === 'good' && item.quantity > 0,
            )
          ) {
            throw new WorkflowProblem(400, 'A selected costume size is unavailable');
          }
        }
      }
      const sourceIds = normalized
        .map((member: any) => member.sourceId)
        .filter(Boolean)
        .map(String);
      if (new Set(sourceIds).size !== sourceIds.length)
        throw new WorkflowProblem(400, 'Roster member IDs cannot be duplicated');
      const oldById = new Map(workflow.members.map((member: any) => [String(member._id), member]));
      workflow.memberRosterHistory.push({
        version: workflow.version,
        changedBy: req.user!._id,
        at: new Date(),
        members: workflow.members.map((member: any) => member.toObject()),
      } as any);
      workflow.members = normalized.map((member: any) => {
        const previous: any = member.sourceId ? oldById.get(String(member.sourceId)) : undefined;
        if (member.sourceId && !previous)
          throw new WorkflowProblem(400, 'A roster member ID is invalid');
        return {
          ...(previous?._id ? { _id: previous._id } : {}),
          ...(previous?.requestId
            ? { requestId: previous.requestId, requestFingerprint: previous.requestFingerprint }
            : {}),
          name: member.name,
          contact: member.contact,
          gender: member.gender,
          height: member.height,
          weight: member.weight,
          costumeSizes: member.costumeSizes.map((item: any) => ({
            costumeId: new Types.ObjectId(item.costumeId),
            size: item.size,
          })),
        } as any;
      }) as any;
      workflow.version += 1;
      if (scopedKey)
        workflow.idempotency.push({
          key: scopedKey,
          fingerprint: rosterFingerprint,
          action: 'members.replace',
          at: new Date(),
        } as any);
      workflow.events.push({
        action: 'members.replace',
        message: 'Booking representative updated the member roster.',
        audience: 'client',
        actor: req.user!._id,
        at: new Date(),
      } as any);
      await workflow.save({ session });
      changed = true;
      bookingResult = booking.toObject();
      workflowResult = workflow;
    });
    sendResponse(
      res,
      200,
      true,
      changed ? 'Member roster updated' : 'Roster update was already recorded',
      await toDto(bookingResult, workflowResult, req.user!),
    );
  } catch (error) {
    const problem = error as WorkflowProblem;
    sendResponse(res, problem.status ?? 500, false, problem.message ?? 'Internal server error');
  }
};

const findPublicWorkflow = async (token: string, session?: ClientSession) => {
  if (token.length < 32 || token.length > 128) return null;
  return BookingWorkflow.findOne({
    'memberEntry.tokenHash': hash(token),
    'memberEntry.opened': true,
  })
    .session(session ?? null)
    .populate('booking') as any;
};

export const getPublicMemberIntake = async (req: Request, res: Response): Promise<void> => {
  const found = await findPublicWorkflow(req.params.token);
  if (!found?.booking || !found.quote?.acceptedAt || found.resources?.schedule) {
    sendResponse(res, 404, false, 'This member intake link is not available');
    return;
  }
  const costumeTypes = found.booking.packageSnapshot?.costumeIds ?? [];
  const costumes = await Costume.find({ type: { $in: costumeTypes } })
    .select('name inventory')
    .sort({ name: 1 })
    .lean();
  const allowedCostumes = costumes.map((item: any) => ({
    costumeId: String(item._id),
    name: item.name,
    sizes: [
      ...new Set(
        (item.inventory ?? [])
          .filter((row: any) => row.condition === 'good' && row.quantity > 0)
          .map((row: any) => row.size),
      ),
    ].sort(),
  }));
  sendResponse(res, 200, true, 'OK', {
    bookingTitle: found.booking.className || found.booking.contactName,
    packageName: found.booking.packageName,
    requestedMembers: found.booking.members,
    allowedCostumes,
  });
};

export const submitPublicMember = async (req: Request, res: Response): Promise<void> => {
  if (!workflowEnabled()) {
    sendResponse(
      res,
      503,
      false,
      'Customer workflow writes are disabled until transactional MongoDB is enabled.',
    );
    return;
  }
  const requestId = cleanText(req.body?.requestId, 128);
  const name = cleanText(req.body?.name, 100);
  const contact = cleanText(req.body?.contact ?? '', 80, false);
  const gender = req.body?.gender;
  const height = req.body?.height === undefined ? undefined : Number(req.body.height);
  const weight = req.body?.weight === undefined ? undefined : Number(req.body.weight);
  const sizes = req.body?.costumeSizes ?? [];
  if (
    !requestId ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId) ||
    !name ||
    contact === null ||
    !['male', 'female', 'other', undefined].includes(gender) ||
    (height !== undefined && (!Number.isFinite(height) || height < 1 || height > 250)) ||
    (weight !== undefined && (!Number.isFinite(weight) || weight < 1 || weight > 500)) ||
    !Array.isArray(sizes) ||
    sizes.length > 20
  ) {
    sendResponse(res, 400, false, 'Member details are invalid');
    return;
  }
  const fingerprint = hash({ name, contact, gender, height, weight, sizes });
  try {
    await withResourceTransaction(async (session) => {
      const found = await findPublicWorkflow(req.params.token, session);
      if (!found?.booking || !found.quote?.acceptedAt || found.resources?.schedule)
        throw new WorkflowProblem(404, 'This member intake link is not available');
      const existing = found.members.find((member: any) => member.requestId === requestId);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint)
          throw new WorkflowProblem(
            409,
            'This request id was already used for different member details',
          );
        return;
      }
      if (found.members.length >= found.booking.members)
        throw new WorkflowProblem(409, 'All member entries have already been received');
      const allowedTypes = found.booking.packageSnapshot?.costumeIds ?? [];
      const costumeIds = sizes.map((item: any) => item?.costumeId);
      if (
        sizes.some(
          (item: any) => !isValidObjectId(item?.costumeId) || typeof item.size !== 'string',
        ) ||
        new Set(costumeIds).size !== costumeIds.length
      )
        throw new WorkflowProblem(400, 'Costume sizes are invalid');
      const costumes = await Costume.find({ _id: { $in: costumeIds }, type: { $in: allowedTypes } })
        .session(session)
        .lean();
      if (costumes.length !== costumeIds.length)
        throw new WorkflowProblem(400, 'A selected costume is not part of this package');
      for (const selection of sizes) {
        const costume: any = costumes.find(
          (item: any) => String(item._id) === String(selection.costumeId),
        );
        if (
          !(costume.inventory ?? []).some(
            (item: any) =>
              item.size === selection.size && item.condition === 'good' && item.quantity > 0,
          )
        )
          throw new WorkflowProblem(400, 'A selected costume size is unavailable');
      }
      found.members.push({
        requestId,
        requestFingerprint: fingerprint,
        name,
        contact,
        gender,
        height,
        weight,
        costumeSizes: sizes.map((item: any) => ({
          costumeId: new Types.ObjectId(item.costumeId),
          size: item.size,
        })),
      });
      found.version += 1;
      found.events.push({
        action: 'member.submit',
        message: 'A class member submitted their information.',
        audience: 'client',
        at: new Date(),
      });
      found.idempotency.push({
        key: `member:${requestId}`,
        fingerprint,
        action: 'member.submit',
        at: new Date(),
      });
      await found.save({ session });
    });
    sendResponse(res, 201, true, 'Member information received', { accepted: true });
  } catch (error) {
    const problem = error as WorkflowProblem;
    sendResponse(res, problem.status ?? 500, false, problem.message ?? 'Internal server error');
  }
};
