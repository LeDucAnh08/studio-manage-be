import { randomBytes, randomUUID } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import Concept from '../models/Concept';
import Package from '../models/ConceptPackage';
import Order from '../models/ConceptOrder';
import Settings from '../models/ConceptSettings';
import Profile from '../models/PhotographerProfile';
import Schedule from '../models/Schedule';
import Costume from '../models/Costume';
import User from '../models/User';
import Transaction from '../models/Transaction';
import Category from '../models/Category';
import EmailOutbox from '../models/EmailOutbox';
import SePayReceipt from '../models/SePayReceipt';
import { emailConfig } from './email';
import { sepayConfig, normalizeBankGateway, sandboxUiEnabled } from './depositPayment';
import { WorkflowProblem, withResourceTransaction } from './workflowTransactions';
import { photographerAvailability, intervalsConflict } from './photographerAvailability';
import { getRentalAvailability, loadRentalHolds } from './rentalAvailability';
import { vietnamDay } from '../utils/rentalPeriod';
import { activeConceptHoldFilter } from './conceptHolds';
import {
  beginCommand,
  cancellationAmounts,
  canReschedule,
  commandKey,
  digest,
  HOLD_MS,
  HOUR,
  integer,
  objectId,
  safeUrl,
  text,
} from './conceptPolicy';

export const admin = (actor: any) => actor.roles.some((r: number) => [0, 1].includes(r));
export const finance = (actor: any) => admin(actor) || actor.roles.includes(5);
export const assigned = (order: any, actor: any) =>
  actor.roles.includes(3) &&
  [order.photographer, order.editor].some((id) => String(id) === String(actor._id));
export const owner = (order: any, actor: any) =>
  actor.roles.includes(6) && String(order.client) === String(actor._id);
export async function accessOrder(id: string, actor: any, session?: ClientSession) {
  const order = await Order.findById(objectId(id))
    .select('+commands +fingerprint')
    .session(session || null);
  if (
    !order ||
    !(
      owner(order, actor) ||
      admin(actor) ||
      assigned(order, actor) ||
      actor.roles.some((r: number) => [2, 5].includes(r))
    )
  )
    throw new WorkflowProblem(404, 'Không tìm thấy đơn concept.');
  return order;
}
export const settings = async (session?: ClientSession) =>
  (await Settings.findById('studio')
    .session(session || null)
    .lean()) || {
    openMinutes: 540,
    closeMinutes: 1140,
    stepMinutes: 30,
    bufferMinutes: 60,
    horizonDays: 90,
    closedWeekdays: [] as number[],
    version: 0,
  };
export const clock = (date: Date) => new Date(+date + 7 * HOUR).toISOString().slice(11, 16);
export const dayString = (date: Date) => new Date(+date + 7 * HOUR).toISOString().slice(0, 10);
export async function rangeFor(pkg: any, value: unknown, session?: ClientSession) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new WorkflowProblem(400, 'Ngày giờ cần kèm múi giờ.');
  const start = new Date(value),
    end = new Date(+start + pkg.durationMinutes * 60000);
  const cfg = await settings(session);
  const shifted = new Date(+start + 7 * HOUR);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  if (
    !Number.isFinite(+start) ||
    +start <= Date.now() ||
    +start > Date.now() + cfg.horizonDays * 86400000 ||
    minutes < cfg.openMinutes ||
    minutes + pkg.durationMinutes > cfg.closeMinutes ||
    (minutes - cfg.openMinutes) % cfg.stepMinutes ||
    shifted.getUTCSeconds() ||
    shifted.getUTCMilliseconds() ||
    cfg.closedWeekdays.includes(shifted.getUTCDay())
  )
    throw new WorkflowProblem(400, 'Khung giờ ngoài giờ mở cửa hoặc ngoài lịch được đặt.');
  return { start, end, cfg };
}
export async function studioFree(
  start: Date,
  end: Date,
  buffer: number,
  session?: ClientSession,
  exclude?: string,
) {
  const rows = await Order.find({
    ...(exclude ? { _id: { $ne: exclude } } : {}),
    $or: [activeConceptHoldFilter(), { status: { $in: ['confirmed', 'shot', 'completed'] } }],
    startAt: { $lt: new Date(+end + buffer * 60000) },
    endAt: { $gt: new Date(+start - buffer * 60000) },
  })
    .select('_id')
    .session(session || null)
    .lean();
  return rows.length === 0;
}
export async function availablePhotographers(
  pkg: any,
  start: Date,
  end: Date,
  session?: ClientSession,
  exclude?: string,
  excludeSchedule?: Types.ObjectId,
) {
  const profiles = await Profile.find({ concepts: pkg.concept, published: true })
    .session(session || null)
    .lean();
  if (!profiles.length) return [];
  const rows = await photographerAvailability(
    { start: +start, end: +end },
    {
      photographerIds: profiles.map((p) => String(p.photographer)),
      session,
      excludeConcept: exclude,
      excludeSchedule,
    },
  );
  return rows
    .filter((r) => r.status === 'available')
    .map((r) => ({
      _id: r._id,
      name: r.name,
      bio: profiles.find((p) => String(p.photographer) === r._id)!.bio,
      portfolio: profiles
        .find((p) => String(p.photographer) === r._id)!
        .portfolio.filter((p) => p.permitted && String(p.concept) === String(pkg.concept))
        .map((p) => ({ url: p.url, caption: p.caption })),
    }));
}
export async function validateResources(order: any, session: ClientSession, exclude?: string) {
  const { start, end, cfg } = await rangeFor(
    order.snapshot,
    new Date(order.startAt).toISOString(),
    session,
  );
  if (!(await studioFree(start, end, cfg.bufferMinutes, session, exclude)))
    throw new WorkflowProblem(409, 'Studio vừa được đặt. Chọn khung giờ khác.');
  const photographers = await availablePhotographers(
    { concept: order.concept },
    start,
    end,
    session,
    exclude,
    order.schedule,
  );
  if (!photographers.some((p) => p._id === String(order.photographer)))
    throw new WorkflowProblem(409, 'Thợ không còn trống hoặc không phù hợp concept.');
  const ids = order.costumes.map((c: any) => String(c.costumeId));
  const costumes = await Costume.find({
    _id: { $in: ids },
    itemKind: 'clothing',
    type: { $in: order.snapshot.costumeTypes },
  })
    .session(session)
    .lean();
  const holds = await loadRentalHolds(ids, session);
  const others = holds.orders.filter((r) => r.conceptOrderId !== exclude);
  const schedules = holds.schedules.filter((r) => String(r._id) !== String(order.schedule));
  let total = 0;
  for (const row of order.costumes) {
    const costume = costumes.find((c) => String(c._id) === String(row.costumeId));
    if (!costume)
      throw new WorkflowProblem(409, 'Trang phục không thuộc gói hoặc đã ngừng sử dụng.');
    const available = getRentalAvailability(
      costume,
      { receiveDate: start, returnDate: end },
      others,
      schedules,
    );
    if ((available[row.size] || 0) < row.quantity)
      throw new WorkflowProblem(409, `Không đủ ${costume.name}, size ${row.size}.`);
    row.name = costume.name;
    total += row.quantity;
  }
  if (total > order.snapshot.costumeCount)
    throw new WorkflowProblem(400, 'Số bộ trang phục vượt giới hạn gói.');
}
export function addRequest(order: any, kind: string, amount: number, expiresAt: Date) {
  const cfg = sepayConfig();
  const request = {
    _id: new Types.ObjectId(),
    kind,
    amount,
    received: 0,
    status: 'pending',
    reference: 'CONC' + randomBytes(8).toString('hex').toUpperCase(),
    mode: cfg.mode,
    bankCode: cfg.bankCode,
    bankGateway: normalizeBankGateway(cfg.bankGateway),
    accountNumber: cfg.accountNumber,
    accountName: cfg.accountName,
    bankName: cfg.bankName,
    createdAt: new Date(),
    expiresAt,
  };
  order.paymentRequests.push(request);
  return request;
}
export const netReceived = (order: any) =>
  order.payments.reduce((s: number, p: any) => s + (p.kind === 'refund' ? -p.amount : p.amount), 0);
export function paymentDto(p: any) {
  let active = false;
  try {
    const cfg = sepayConfig();
    active =
      cfg.mode === p.mode &&
      cfg.bankCode === p.bankCode &&
      cfg.accountNumber === p.accountNumber &&
      normalizeBankGateway(cfg.bankGateway) === p.bankGateway;
  } catch {
    /* disabled or rotated */
  }
  const status =
    p.status !== 'pending'
      ? p.status
      : !active
        ? 'unavailable'
        : +p.expiresAt <= Date.now()
          ? 'expired'
          : 'pending';
  const amount = Math.max(0, p.amount - p.received);
  return {
    id: String(p._id),
    kind: p.kind,
    reference: p.reference,
    amount,
    total: p.amount,
    received: p.received,
    bankName: p.bankName,
    accountNumber: p.accountNumber,
    accountName: p.accountName,
    expiresAt: p.expiresAt,
    status,
    demoSimulation: sandboxUiEnabled(),
    qrUrl:
      status === 'pending'
        ? `https://vietqr.app/img?${new URLSearchParams({ acc: p.accountNumber, bank: p.bankCode, amount: String(amount), des: p.reference, template: 'qronly', holder: p.accountName })}`
        : null,
  };
}
export function orderDto(order: any, actor: any) {
  const raw = order.toObject ? order.toObject() : { ...order };
  delete raw.commands;
  delete raw.fingerprint;
  delete raw.checkoutKey;
  const monetary = owner(order, actor) || finance(actor);
  raw.paymentRequests = monetary ? order.paymentRequests.map(paymentDto) : [];
  if (!monetary) {
    delete raw.payments;
    delete raw.refundDue;
    delete raw.retained;
    raw.snapshot = {
      name: order.snapshot.name,
      conceptName: order.snapshot.conceptName,
      durationMinutes: order.snapshot.durationMinutes,
      retouchQuota: order.snapshot.retouchQuota,
    };
  }
  if (order.status === 'awaiting_deposit' && +order.reservation.expiresAt <= Date.now())
    raw.status = 'expired';
  return {
    ...raw,
    netReceived: monetary ? netReceived(order) : undefined,
    canManage: admin(actor),
    canEdit: admin(actor) || assigned(order, actor),
    canAccount: finance(actor),
    isOwner: owner(order, actor),
    canReschedule: owner(order, actor) && canReschedule(order),
    canCancel:
      owner(order, actor) &&
      ['awaiting_deposit', 'confirmed'].includes(raw.status) &&
      +order.startAt > Date.now(),
  };
}
export function event(order: any, action: string, message: string, actor?: any) {
  order.events.push({ action, message, at: new Date(), actor: actor?._id });
}
export async function enqueueConceptEmail(order: any, session: ClientSession) {
  let config: ReturnType<typeof emailConfig>;
  try {
    config = emailConfig();
  } catch {
    return;
  }
  if (!config) return;
  const user = await User.findById(order.client).session(session);
  if (!user?.email || !user.emailVerifiedAt || !user.isActive) return;
  const text = `Đơn ${order.snapshot.name}: ${order.events[order.events.length - 1]?.message || order.status}. Xem hồ sơ: ${config.origin}/account/concept-orders/${order._id}`;
  await EmailOutbox.updateOne(
    { dedupeKey: `concept:${order._id}:${order.version}` },
    {
      $setOnInsert: {
        kind: 'concept_update',
        conceptOrder: order._id,
        user: user._id,
        to: user.email,
        mode: config.mode,
        payload: {
          from: config.from,
          to: [user.email],
          subject: 'Cập nhật đơn chụp concept — Yume Studio',
          text,
        },
      },
    },
    { upsert: true, session },
  );
}
export async function ledger(
  order: any,
  amount: number,
  kind: string,
  session: ClientSession,
  receipt?: any,
  actor?: any,
  reference?: string,
) {
  const type = kind === 'refund' ? 'expense' : 'income';
  let category = await Category.findOne({ name: 'Chụp concept', type }).session(session);
  if (!category)
    [category] = await Category.create([{ name: 'Chụp concept', type, isDefault: false }], {
      session,
    });
  const paymentId = new Types.ObjectId();
  await Transaction.create(
    [
      {
        type,
        amount,
        categoryId: category._id,
        conceptOrder: order._id,
        conceptPayment: paymentId,
        description: `${kind}: ${order.snapshot.name}`,
        date: new Date(),
        createdBy: actor?._id,
        paymentSource: receipt ? 'sepay' : 'manual',
        providerReceipt: receipt?._id,
      },
    ],
    { session },
  );
  order.payments.push({
    _id: paymentId,
    amount,
    kind,
    receipt: receipt?._id,
    actor: actor?._id,
    reference,
    at: new Date(),
  });
}
export async function confirm(order: any, session: ClientSession) {
  await validateResources(order, session, String(order._id));
  const [schedule] = await Schedule.create(
    [
      {
        conceptOrder: order._id,
        customer: null,
        conceptTitle: `${order.snapshot.conceptName} · ${order.contactName}`,
        shootDate: vietnamDay(order.startAt),
        startTime: clock(order.startAt),
        endTime: clock(order.endAt),
        location: 'Studio',
        leadPhotographer: order.photographer,
        supportPhotographers: [],
        status: 'confirmed',
        costumes: order.costumes.map((c: any) => c.costumeId),
        costumeReservations: order.costumes.map((c: any) => ({
          costume: c.costumeId,
          size: c.size,
          quantity: c.quantity,
          receiveDate: vietnamDay(order.startAt),
          returnDate: vietnamDay(order.endAt),
        })),
      },
    ],
    { session },
  );
  order.schedule = schedule._id;
  order.status = 'confirmed';
  order.reservation.status = 'transferred';
}
export async function checkout(actor: any, body: any, key: string) {
  commandKey(key);
  const fingerprint = digest(body);
  return withResourceTransaction(async (session) => {
    const prior = await Order.findOne({ client: actor._id, checkoutKey: key })
      .select('+fingerprint')
      .session(session);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new WorkflowProblem(409, 'Khóa checkout đã được dùng.');
      return prior;
    }
    const user = await User.findById(actor._id).session(session);
    if (!actor.roles.includes(6) || !user?.email || !user.emailVerifiedAt || !user.isActive)
      throw new WorkflowProblem(403, 'Xác thực email trước khi đặt cọc.');
    if (
      (await Order.countDocuments({ client: actor._id, ...activeConceptHoldFilter() }).session(
        session,
      )) >= 2
    )
      throw new WorkflowProblem(409, 'Bạn đang có hai đơn chờ cọc.');
    const pkg = await Package.findOne({ _id: objectId(body.packageId), active: true })
      .session(session)
      .lean();
    const concept =
      pkg && (await Concept.findOne({ _id: pkg.concept, active: true }).session(session).lean());
    if (!pkg || !concept) throw new WorkflowProblem(409, 'Gói không còn khả dụng.');
    if (body.packageVersion !== pkg.version || body.accepted !== true)
      throw new WorkflowProblem(409, 'Kiểm tra và đồng ý giá gói hiện tại.');
    const { start, end } = await rangeFor(pkg, body.startAt, session);
    const snapshot = {
      ...pkg,
      conceptName: concept.name,
      deposit: Math.ceil((pkg.price * 30) / 100),
      policyVersion: 1,
      depositPercent: 30,
      holdMinutes: 15,
      freeFeedbackRounds: 2,
      acceptedAt: new Date(),
    };
    if (!Array.isArray(body.costumes) || body.costumes.length > 100)
      throw new WorkflowProblem(400, 'Danh sách trang phục không hợp lệ.');
    const seen = new Set<string>();
    const costumes = body.costumes.map((row: any) => {
      const costumeId = objectId(row.costumeId),
        size = text(row.size, 12),
        quantity = integer(row.quantity, 1, 100);
      if (seen.has(`${costumeId}:${size}`)) throw new WorkflowProblem(400, 'Trang phục bị trùng.');
      seen.add(`${costumeId}:${size}`);
      return { costumeId, size, quantity };
    });
    const phone = text(body.phone, 25);
    if (!/^(?:0\d{9}|\+84\d{9})$/.test(phone))
      throw new WorkflowProblem(400, 'Số điện thoại không hợp lệ.');
    if (!Array.isArray(body.references) || body.references.length > 10)
      throw new WorkflowProblem(400, 'Tối đa 10 link ảnh mẫu.');
    const order = new Order({
      client: actor._id,
      concept: concept._id,
      package: pkg._id,
      snapshot,
      contactName: text(body.contactName, 100),
      phone,
      people: integer(body.people, 1, pkg.maxPeople),
      brief: text(body.brief, 4000, false),
      references: body.references.map(safeUrl),
      photographer: objectId(body.photographerId),
      startAt: start,
      endAt: end,
      originalStartAt: start,
      costumes,
      checkoutKey: key,
      fingerprint,
      reservation: { status: 'held', expiresAt: new Date(Date.now() + HOLD_MS) },
    });
    await validateResources(order, session);
    addRequest(order, 'deposit', snapshot.deposit, order.reservation!.expiresAt);
    event(order, 'checkout', 'Đang giữ chỗ 15 phút; chờ cọc 30%.', actor);
    await order.save({ session });
    return order;
  });
}
export async function expireConceptOrders(now = new Date()) {
  const rows = await Order.find({
    status: 'awaiting_deposit',
    'reservation.status': 'held',
    'reservation.expiresAt': { $lte: now },
  })
    .select('_id')
    .lean();
  for (const row of rows)
    await withResourceTransaction(async (session) => {
      const order = await Order.findById(row._id).session(session);
      if (!order || order.status !== 'awaiting_deposit' || order.reservation!.expiresAt > now)
        return;
      order.status = 'expired';
      order.reservation!.status = 'released';
      order.version += 1;
      order.refundDue = netReceived(order);
      order.paymentRequests.forEach((p) => {
        if (p.status === 'pending') p.status = 'void';
      });
      event(order, 'expired', 'Hết thời hạn cọc; đã giải phóng giữ chỗ.');
      await order.save({ session });
    });
}
export async function orderCommand(
  id: string,
  actor: any,
  operation: string,
  body: any,
  key: string,
) {
  commandKey(key);
  return withResourceTransaction(async (session) => {
    const order = await accessOrder(id, actor, session);
    if (
      !beginCommand(
        order,
        key,
        { actor: String(actor._id), operation, ...body },
        body.expectedVersion,
      )
    )
      return order;
    if (operation === 'reschedule') {
      if (!owner(order, actor) || !canReschedule(order))
        throw new WorkflowProblem(409, 'Chỉ được đổi một lần trước ít nhất 48 giờ.');
      const { start, end } = await rangeFor(order.snapshot, body.startAt, session);
      if (+start < Date.now() + 48 * HOUR || +start === +order.startAt)
        throw new WorkflowProblem(400, 'Chọn lịch mới trước ít nhất 48 giờ.');
      order.startAt = start;
      order.endAt = end;
      await validateResources(order, session, id);
      await Schedule.updateOne(
        { _id: order.schedule, conceptOrder: order._id },
        {
          $set: {
            shootDate: vietnamDay(start),
            startTime: clock(start),
            endTime: clock(end),
            costumeReservations: order.costumes.map((c) => ({
              costume: c.costumeId,
              size: c.size,
              quantity: c.quantity,
              receiveDate: vietnamDay(start),
              returnDate: vietnamDay(end),
            })),
          },
        },
        { session },
      );
      order.rescheduleCount += 1;
      event(order, operation, `Đã đổi lịch sang ${dayString(start)} ${clock(start)}.`, actor);
    } else if (operation === 'cancel') {
      if (!owner(order, actor)) throw new WorkflowProblem(403, 'Chỉ chủ đơn được tự hủy.');
      const amounts = cancellationAmounts(order);
      order.status = 'cancelled';
      order.reservation!.status = 'released';
      Object.assign(order, amounts);
      order.paymentRequests.forEach((p) => {
        if (p.status === 'pending') p.status = 'void';
      });
      if (order.schedule)
        await Schedule.updateOne(
          { _id: order.schedule },
          { $set: { status: 'cancelled' } },
          { session },
        );
      event(
        order,
        operation,
        `Đã hủy. Giữ ${amounts.retained} đ; cần hoàn ${amounts.refundDue} đ.`,
        actor,
      );
    } else if (operation === 'assign') {
      if (!admin(actor) || !['confirmed', 'shot'].includes(order.status))
        throw new WorkflowProblem(403, 'Không được phân công.');
      const editor = await User.findOne({
        _id: objectId(body.editorId),
        roles: 3,
        isActive: true,
      }).session(session);
      if (!editor) throw new WorkflowProblem(400, 'Chọn thợ đang hoạt động.');
      order.editor = editor._id;
    } else if (operation === 'wardrobe') {
      if (!admin(actor) || !['confirmed', 'shot'].includes(order.status))
        throw new WorkflowProblem(403, 'Không được cập nhật trang phục.');
      if (
        !['prepared', 'returned'].includes(body.status) ||
        (body.status === 'returned' && order.status !== 'shot')
      )
        throw new WorkflowProblem(400, 'Trạng thái không hợp lệ.');
      order.wardrobe = body.status;
    } else if (operation === 'shot') {
      if (
        !(admin(actor) || assigned(order, actor)) ||
        order.status !== 'confirmed' ||
        +order.startAt > Date.now()
      )
        throw new WorkflowProblem(409, 'Chưa thể đánh dấu đã chụp.');
      order.status = 'shot';
      order.shotAt = new Date();
      await Schedule.updateOne(
        { _id: order.schedule },
        { $set: { status: 'completed' } },
        { session },
      );
      addRequest(
        order,
        'balance',
        order.snapshot.price - order.snapshot.deposit,
        new Date(Date.now() + 30 * 86400000),
      );
    } else if (operation === 'renew-payment') {
      if (!(owner(order, actor) || finance(actor)))
        throw new WorkflowProblem(403, 'Không được tạo khoản thu.');
      const previous = order.paymentRequests.find((p) => String(p._id) === body.paymentId);
      if (
        !previous ||
        previous.kind === 'deposit' ||
        previous.status !== 'pending' ||
        +previous.expiresAt! > Date.now() ||
        !['shot', 'completed'].includes(order.status)
      )
        throw new WorkflowProblem(409, 'Khoản thu không thể gia hạn.');
      previous.status = 'void';
      const next = addRequest(
        order,
        previous.kind,
        previous.amount - previous.received,
        new Date(Date.now() + 7 * 86400000),
      );
      // Paid retouch requests reference the replacement intent, not the expired QR.
      if (previous.kind === 'revision') {
        const { default: Album } = await import('../models/ConceptAlbum');
        const album = await Album.findOne({ order: order._id }).session(session);
        const request = album?.paidRequests.find((r: any) => r.reference === previous.reference);
        if (album && request) {
          request.reference = next.reference;
          album.markModified('paidRequests');
          album.version += 1;
          await album.save({ session });
        }
      }
    } else if (operation === 'reconcile') {
      if (!finance(actor)) throw new WorkflowProblem(403, 'Chỉ kế toán đối soát.');
      const receipt = await SePayReceipt.findById(objectId(body.receiptId)).session(session);
      const note = text(body.note, 1000);
      const config = sepayConfig();
      if (
        !receipt ||
        receipt.status !== 'review' ||
        receipt.hasConflict ||
        receipt.direction !== 'in' ||
        receipt.booking ||
        receipt.rentalOrder ||
        (receipt.conceptOrder && String(receipt.conceptOrder) !== id) ||
        receipt.mode !== config.mode ||
        receipt.accountNumber !== config.accountNumber ||
        receipt.gateway !== normalizeBankGateway(config.bankGateway)
      )
        throw new WorkflowProblem(409, 'Chứng từ không đủ điều kiện đối soát.');
      const referenceCodes = [
        ...new Set<string>(
          receipt.content.toUpperCase().match(/\b(?:CONC|YUME|RENT)[A-F0-9]{16}\b/g) || [],
        ),
      ];
      if (
        referenceCodes.length &&
        !order.paymentRequests.some(
          (p) => referenceCodes.length === 1 && p.reference === referenceCodes[0],
        )
      )
        throw new WorkflowProblem(409, 'Không chuyển tiền đã khớp mã khác sang đơn này.');
      if (['cancelled', 'expired'].includes(order.status)) {
        await ledger(order, receipt.amount, 'unallocated', session, receipt);
        order.refundDue += receipt.amount;
      } else {
        const request = order.paymentRequests.find(
          (p) => String(p._id) === body.paymentId && p.status === 'pending',
        );
        if (
          !request ||
          request.kind === 'deposit' ||
          receipt.amount > request.amount - request.received ||
          receipt.mode !== request.mode ||
          receipt.accountNumber !== request.accountNumber ||
          receipt.gateway !== request.bankGateway
        )
          throw new WorkflowProblem(
            409,
            'Chỉ đối soát khoản thu còn thiếu sau xác nhận; cọc có vấn đề cần hủy/hoàn rồi đặt lại.',
          );
        await ledger(order, receipt.amount, request.kind, session, receipt);
        request.received += receipt.amount;
        if (request.received === request.amount) request.status = 'paid';
        if (request.status === 'paid' && ['extra', 'revision'].includes(request.kind)) {
          const { default: Album } = await import('../models/ConceptAlbum');
          const album = await Album.findOne({ order: order._id }).session(session);
          if (album) {
            if (request.kind === 'extra' && album.status === 'awaiting_extra')
              album.status = 'queued';
            const paid = album.paidRequests.find((r: any) => r.reference === request.reference);
            if (paid) {
              paid.status = 'paid';
              album.markModified('paidRequests');
            }
            album.version += 1;
            await album.save({ session });
          }
        }
      }
      receipt.conceptOrder = order._id;
      receipt.status = 'applied';
      receipt.conceptPayment = order.payments[order.payments.length - 1]._id;
      receipt.resolvedBy = actor._id;
      receipt.resolutionNote = note;
      receipt.resolvedAt = new Date();
      await receipt.save({ session });
    } else if (operation === 'exception-cancel') {
      if (!admin(actor) || ['cancelled', 'expired'].includes(order.status))
        throw new WorkflowProblem(403, 'Chỉ admin xử lý ngoại lệ.');
      const reason = text(body.note, 1000),
        refundDue = integer(body.refundDue, 0, netReceived(order));
      order.status = 'cancelled';
      order.refundDue = refundDue;
      order.retained = netReceived(order) - refundDue;
      order.reservation!.status = 'released';
      order.paymentRequests.forEach((p) => {
        if (p.status === 'pending') p.status = 'void';
      });
      if (order.schedule)
        await Schedule.updateOne(
          { _id: order.schedule },
          { $set: { status: 'cancelled' } },
          { session },
        );
      event(order, operation, `Ngoại lệ hủy: ${reason}; cần hoàn ${refundDue} đ.`, actor);
    } else if (operation === 'refund') {
      if (!finance(actor)) throw new WorkflowProblem(403, 'Chỉ kế toán ghi hoàn tiền.');
      const amount = integer(body.amount, 1, order.refundDue);
      const reference = text(body.reference, 120);
      if (order.payments.some((p) => p.kind === 'refund' && p.reference === reference))
        throw new WorkflowProblem(409, 'Chứng từ hoàn đã được ghi.');
      await ledger(order, amount, 'refund', session, undefined, actor, reference);
      order.refundDue -= amount;
    } else throw new WorkflowProblem(404, 'Không có thao tác này.');
    event(
      order,
      operation,
      operation === 'shot'
        ? 'Buổi chụp hoàn tất; mời thanh toán phần còn lại.'
        : 'Đã cập nhật hồ sơ đơn.',
      actor,
    );
    await order.save({ session });
    await enqueueConceptEmail(order, session);
    return order;
  });
}
