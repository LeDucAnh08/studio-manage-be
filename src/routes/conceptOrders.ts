import { Router } from 'express';
import Order from '../models/ConceptOrder';
import Photo from '../models/ConceptPhoto';
import User from '../models/User';
import { protect } from '../middleware/auth';
import { sendResponse } from '../utils/response';
import { conceptGate, conceptHandler } from './concepts';
import {
  accessOrder,
  admin,
  checkout,
  expireConceptOrders,
  orderCommand,
  orderDto,
} from '../services/conceptBooking';
import {
  albumAccess,
  albumCommand,
  albumDto,
  guestAccess,
  photoFor,
  readConceptPhoto,
} from '../services/conceptAlbum';
import { commandKey, conceptOrderStatuses, integer } from '../services/conceptPolicy';
import { WorkflowProblem } from '../services/workflowTransactions';
import { activeConceptHoldFilter } from '../services/conceptHolds';
import { createRateLimit } from '../middleware/authRateLimit';

const router = Router();
router.use(conceptGate, protect);
router.use(createRateLimit({ limit: 180, windowMs: 60000, message: 'Thử lại sau một phút.' }));
router.get(
  '/',
  conceptHandler(async (req, res) => {
    await expireConceptOrders();
    const page = integer(Number(req.query.page || 1), 1, 100000),
      limit = integer(Number(req.query.limit || 20), 1, 100);
    const actor = req.user;
    let scope: any;
    if (admin(actor) || actor.roles.some((r: number) => [2, 5].includes(r))) scope = {};
    else if (actor.roles.includes(3))
      scope = { $or: [{ photographer: actor._id }, { editor: actor._id }] };
    else if (actor.roles.includes(6)) scope = { client: actor._id };
    else throw new WorkflowProblem(403, 'Không có quyền xem đơn concept.');
    const statusFilter =
      req.query.view !== undefined
        ? { status: { $in: conceptOrderStatuses(req.query.view) } }
        : req.query.status
          ? { status: String(req.query.status) }
          : {};
    const filter = { ...scope, ...statusFilter };
    const rows = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
    sendResponse(
      res,
      200,
      true,
      'OK',
      rows.map((r) => orderDto(r, actor)),
      { page, limit, total: await Order.countDocuments(filter) },
    );
  }),
);
router.post(
  '/',
  conceptHandler(async (req, res) => {
    const order = await checkout(req.user, req.body, req.get('Idempotency-Key') || '');
    sendResponse(res, 201, true, 'Đang giữ chỗ 15 phút.', orderDto(order, req.user));
  }),
);
router.get(
  '/staff',
  conceptHandler(async (req, res) => {
    if (!admin(req.user)) throw new WorkflowProblem(403, 'Chỉ quản trị.');
    sendResponse(
      res,
      200,
      true,
      'OK',
      await User.find({ roles: 3, isActive: true }).select('_id name username').lean(),
    );
  }),
);
router.get(
  '/calendar-holds',
  conceptHandler(async (req, res) => {
    if (!req.user.roles.some((r: number) => [0, 1, 2, 3].includes(r)))
      throw new WorkflowProblem(403, 'Chỉ nhân sự xem lịch giữ chỗ.');
    const rows = await Order.find({
      ...activeConceptHoldFilter(),
      ...(req.user.roles.includes(3) && !admin(req.user) && !req.user.roles.includes(2)
        ? { photographer: req.user._id }
        : {}),
    })
      .select('startAt endAt reservation snapshot photographer contactName')
      .populate('photographer', 'name username')
      .limit(10000)
      .lean();
    sendResponse(
      res,
      200,
      true,
      'OK',
      rows.map((row: any) => ({
        _id: `concept:${row._id}`,
        shootDate: row.startAt,
        startTime: new Date(+row.startAt + 7 * 3600000).toISOString().slice(11, 16),
        endTime: new Date(+row.endAt + 7 * 3600000).toISOString().slice(11, 16),
        status: 'pending',
        className: `Giữ chỗ concept · ${row.snapshot.name}`,
        leadName: row.photographer?.name,
        notes: `Hạn cọc: ${row.reservation.expiresAt.toISOString()}`,
      })),
    );
  }),
);
router.get(
  '/:id',
  conceptHandler(async (req, res) => {
    await expireConceptOrders();
    sendResponse(
      res,
      200,
      true,
      'OK',
      orderDto(await accessOrder(req.params.id, req.user), req.user),
    );
  }),
);
router.get(
  '/:id/album',
  conceptHandler(async (req, res) => {
    const access = await albumAccess(req.params.id, req.user);
    sendResponse(res, 200, true, 'OK', await albumDto(access.album, access.staff));
  }),
);
router.post(
  '/:id/album/:operation',
  conceptHandler(async (req, res) => {
    const result = await albumCommand(
      req.params.id,
      req.user,
      req.params.operation,
      req.body,
      req.get('Idempotency-Key') || '',
    );
    const order = await accessOrder(req.params.id, req.user);
    sendResponse(res, 200, true, 'Đã lưu album.', {
      ...(await albumDto(
        result.album,
        admin(req.user) ||
          [order.photographer, order.editor].some((id) => String(id) === String(req.user._id)),
      )),
      token: result.token,
    });
  }),
);
router.get(
  '/:id/album/photos/:photoId',
  conceptHandler(async (req, res) => {
    const access = await albumAccess(req.params.id, req.user);
    const photo = await photoFor(access, req.params.photoId, req.query.download === 'true');
    const image = await readConceptPhoto(photo, req.query.size === 'thumb');
    res.set('Cache-Control', 'no-store');
    if (req.query.download === 'true') res.attachment(photo.drive.name.replace(/[\r\n/\\]/g, '_'));
    res.type(image.type).send(image.bytes);
  }),
);
router.get(
  '/:id/album/zip',
  conceptHandler(async (req, res) => {
    const access = await albumAccess(req.params.id, req.user);
    if (!access.album.allowDownload) throw new WorkflowProblem(403, 'Studio chưa cho tải ảnh.');
    const version = req.query.version
      ? integer(Number(req.query.version), 1, access.album.deliveryVersion)
      : access.album.deliveryVersion;
    const photos = await Photo.find({ album: access.album._id, version, available: true }).sort({
      order: 1,
    });
    if (!photos.length) throw new WorkflowProblem(404, 'Chưa có ảnh bàn giao.');
    // archiver is also used by the installed Excel tooling; stream one verified image at a time.
    const archive = require('archiver')('zip', { store: true });
    res.attachment(`concept-v${version}.zip`);
    res.set('Cache-Control', 'no-store');
    archive.on('error', () => res.destroy());
    res.on('close', () => {
      archive.abort();
    });
    archive.pipe(res);
    try {
      for (const [index, photo] of photos.entries()) {
        if (res.destroyed) break;
        // Recheck permission between files; revoked access cannot continue a long export.
        if (!(await albumAccess(req.params.id, req.user)).album.allowDownload)
          throw new WorkflowProblem(403, 'Đã thu hồi quyền tải.');
        const image = await readConceptPhoto(photo, false);
        // Wait for this entry to drain before fetching another image.
        await new Promise<void>((resolve, reject) => {
          const clean = () => {
            archive.off('entry', done);
            archive.off('error', fail);
            res.off('close', closed);
          };
          const done = () => {
            clean();
            resolve();
          };
          const fail = (error: Error) => {
            clean();
            reject(error);
          };
          const closed = () => fail(new Error('Download closed'));
          archive.once('entry', done);
          archive.once('error', fail);
          res.once('close', closed);
          archive.append(image.bytes, {
            name: `${index + 1}-${photo.drive.name.replace(/[\r\n/\\]/g, '_')}`,
          });
        });
      }
      await archive.finalize();
    } catch {
      archive.abort();
      res.destroy();
    }
  }),
);
router.post(
  '/:id/:operation',
  conceptHandler(async (req, res) => {
    const result = await orderCommand(
      req.params.id,
      req.user,
      req.params.operation,
      req.body,
      commandKey(req.get('Idempotency-Key')),
    );
    sendResponse(res, 200, true, 'Đã cập nhật.', orderDto(result, req.user));
  }),
);
export const publicConceptAlbums = Router();
publicConceptAlbums.use(conceptGate);
publicConceptAlbums.use(createRateLimit({ limit: 300, windowMs: 60000, message: 'Thử lại sau.' }));
publicConceptAlbums.get(
  '/:publicId',
  conceptHandler(async (req, res) => {
    const access = await guestAccess(req.params.publicId, req.get('X-Album-Token'));
    res.set('Cache-Control', 'no-store');
    sendResponse(res, 200, true, 'OK', await albumDto(access.album, false, true));
  }),
);
publicConceptAlbums.get(
  '/:publicId/photos/:photoId',
  conceptHandler(async (req, res) => {
    const access = await guestAccess(req.params.publicId, req.get('X-Album-Token'));
    if (req.query.download !== undefined)
      throw new WorkflowProblem(403, 'Link chia sẻ chỉ cho xem.');
    const photo = await photoFor(access, req.params.photoId, false, true);
    const image = await readConceptPhoto(photo, req.query.size === 'thumb');
    res.set('Cache-Control', 'no-store');
    res.type(image.type).send(image.bytes);
  }),
);
export default router;
