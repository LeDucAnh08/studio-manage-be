import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { isValidObjectId } from 'mongoose';
import Album from '../models/BookingAlbum';
import Photo from '../models/BookingAlbumPhoto';
import Selection from '../models/BookingAlbumSelection';
import Booking from '../models/Booking';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireClientPortal } from '../middleware/featureFlags';
import { createRateLimit } from '../middleware/authRateLimit';
import { sendResponse } from '../utils/response';
import { WorkflowProblem } from '../services/workflowTransactions';
import { listDriveFolders } from '../services/driveAlbumSource';
import { deliveryAccess } from '../services/bookingDelivery';
import {
  albumDto,
  albumHash,
  mutateAlbum,
  ownerAlbumAccess,
  publicAlbumAccess,
  readAlbumPhoto,
  staffAlbumAccess,
  syncAlbumPhotos,
} from '../services/bookingAlbum';

export const albumRoutes = Router({ mergeParams: true });
export const publicAlbumRoutes = Router({ mergeParams: true });
const handle = (work: Parameters<typeof asyncHandler>[0]) =>
  asyncHandler(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      await work(req, res, next);
    } catch (error) {
      const problem = error as WorkflowProblem;
      if (!res.headersSent)
        sendResponse(
          res,
          problem.status || 500,
          false,
          problem.status ? problem.message : 'Chưa thể xử lý album. Thử lại sau.',
        );
    }
  });
albumRoutes.get(
  '/',
  handle(async (req, res) => {
    const access = await deliveryAccess(req.params.id, req.user!);
    const album = await Album.findOne({ booking: req.params.id });
    if (
      !access.staff &&
      (!album || album.status === 'draft' || access.booking.status !== 'approved')
    ) {
      sendResponse(res, 200, true, 'OK', null);
      return;
    }
    sendResponse(res, 200, true, 'OK', album ? await albumDto(album, access.staff) : null);
  }),
);
albumRoutes.post(
  '/:operation',
  handle(async (req, res) => {
    const operation = req.params.operation;
    if (['photo', 'finalize'].includes(operation)) {
      const album = await interactAlbum(
        {
          bookingId: req.params.id,
          customer: req.user!,
          expectedVersion: req.body.expectedVersion,
          key: req.get('Idempotency-Key') || '',
          operation,
          payload: req.body,
        },
        operation,
        req.body,
      );
      sendResponse(res, 200, true, 'Đã lưu.', await albumDto(album));
      return;
    }
    if (
      ![
        'configure',
        'sync',
        'delivery-sync',
        'publish',
        'close',
        'reopen',
        'share',
        'revoke',
        'cover',
      ].includes(operation)
    )
      throw new WorkflowProblem(404, 'Không tìm thấy thao tác.');
    await staffAlbumAccess(req.params.id, req.user!);
    let source: Awaited<ReturnType<typeof listDriveFolders>> | undefined;
    if (['configure', 'sync', 'delivery-sync'].includes(operation)) {
      const album = await Album.findOne({ booking: req.params.id });
      const folders =
        operation === 'sync'
          ? album?.folders.map(
              (f) =>
                `https://drive.google.com/drive/folders/${f.id}${f.resourceKey ? `?resourcekey=${f.resourceKey}` : ''}`,
            )
          : req.body.folders;
      source = await listDriveFolders(folders);
    }
    if (operation === 'share' && !process.env.JWT_SECRET)
      throw new WorkflowProblem(503, 'Chưa cấu hình bí mật xác thực.');
    const token =
      operation === 'share'
        ? createHmac('sha256', process.env.JWT_SECRET!)
            .update(
              JSON.stringify([
                'album-share',
                req.params.id,
                String(req.user!._id),
                req.get('Idempotency-Key'),
              ]),
            )
            .digest('base64url')
        : undefined;
    const album = await mutateAlbum(
      {
        bookingId: req.params.id,
        actor: req.user!,
        expectedVersion: req.body.expectedVersion,
        key: req.get('Idempotency-Key') || '',
        operation,
        payload: req.body,
      },
      async (a, workflow, session) => {
        if (
          ['configure', 'sync', 'publish', 'reopen'].includes(operation) &&
          workflow.lifecycle !== 'editing'
        )
          throw new WorkflowProblem(409, 'Chỉ mở/cập nhật lựa chọn khi đơn đang hậu kỳ.');
        if (operation === 'configure') {
          if (
            typeof req.body.title !== 'string' ||
            !req.body.title.trim() ||
            req.body.title.trim().length > 160 ||
            !Number.isInteger(req.body.limit) ||
            req.body.limit < 0 ||
            req.body.limit > 10000
          )
            throw new WorkflowProblem(
              400,
              'Kiểm tra tên album và giới hạn chọn (0 là không giới hạn).',
            );
          if (a.status === 'closed')
            throw new WorkflowProblem(409, 'Mở lại lựa chọn trước khi sửa album.');
          const selected = await Photo.countDocuments({
            album: a._id,
            deliveryVersion: 0,
            selected: true,
            available: true,
          }).session(session);
          if (req.body.limit && req.body.limit < selected)
            throw new WorkflowProblem(409, 'Giới hạn mới nhỏ hơn số ảnh đã chọn.');
          a.title = req.body.title.trim();
          a.limit = req.body.limit;
        }
        if (source) {
          if (
            operation === 'delivery-sync' &&
            !['editing', 'revision_requested'].includes(workflow.lifecycle)
          )
            throw new WorkflowProblem(
              409,
              'Chỉ chuẩn bị ảnh bàn giao khi đang hậu kỳ/cần chỉnh sửa.',
            );
          await syncAlbumPhotos(a, source.images, operation === 'delivery-sync' ? -1 : 0, session);
          if (
            operation !== 'delivery-sync' &&
            a.limit &&
            (await Photo.countDocuments({
              album: a._id,
              deliveryVersion: 0,
              available: true,
              selected: true,
            }).session(session)) > a.limit
          )
            throw new WorkflowProblem(
              409,
              'Ảnh trở lại thư mục khiến lựa chọn vượt giới hạn. Tăng giới hạn trước khi đồng bộ.',
            );
          a.skipped = source.skipped;
          if (operation !== 'delivery-sync') {
            a.folders = source.folders;
            if (!source.images.some((p) => p.id === a.coverId)) a.coverId = source.images[0]?.id;
          }
        }
        if (operation === 'publish' || operation === 'reopen') {
          if (
            !(await Photo.exists({ album: a._id, deliveryVersion: 0, available: true }).session(
              session,
            ))
          )
            throw new WorkflowProblem(400, 'Album cần có ảnh trước khi mở chọn.');
          a.status = 'open';
          a.finalizedAt = undefined;
        }
        if (operation === 'close') {
          if (a.status !== 'open') throw new WorkflowProblem(409, 'Album chưa mở chọn.');
          a.status = 'closed';
        }
        if (operation === 'share') {
          a.tokenHash = albumHash(token!);
          a.shared = true;
        }
        if (operation === 'revoke') {
          a.shared = false;
          a.tokenHash = undefined;
        }
        if (operation === 'cover') {
          if (typeof req.body.coverId !== 'string' || !/^[\w-]{10,200}$/.test(req.body.coverId))
            throw new WorkflowProblem(400, 'Ảnh bìa không hợp lệ.');
          if (
            !(await Photo.exists({
              album: a._id,
              deliveryVersion: 0,
              available: true,
              'drive.id': req.body.coverId,
            }).session(session))
          )
            throw new WorkflowProblem(400, 'Chọn ảnh bìa thuộc album.');
          a.coverId = req.body.coverId;
        }
      },
    );
    // Replaying share cannot return a different secret for the existing token hash.
    const actual = await Album.findById(album._id).select('+tokenHash');
    sendResponse(res, 200, true, 'Đã lưu album.', {
      ...(await albumDto(album, true)),
      ...(token && actual?.tokenHash === albumHash(token) ? { token } : {}),
    });
  }),
);
albumRoutes.get(
  '/export/names',
  handle(async (req, res) => {
    await staffAlbumAccess(req.params.id, req.user!);
    const album = await Album.findOne({ booking: req.params.id });
    if (!album) throw new WorkflowProblem(404, 'Chưa tạo album.');
    const round = req.query.round === undefined ? 0 : Number(req.query.round);
    if (!Number.isInteger(round) || round < 0 || round > album.selectionHistory.length)
      throw new WorkflowProblem(400, 'Lần chốt không hợp lệ.');
    const snapshot = round
      ? await Selection.find({ album: album._id, round }).sort({ _id: 1 })
      : null;
    const photos = await Photo.find({
      album: album._id,
      deliveryVersion: 0,
      available: true,
      selected: true,
    }).sort({ order: 1 });
    const names = (snapshot ? snapshot.map((p) => p.name) : photos.map((p) => p.drive.name)).map(
      (name) => (req.query.extension === 'false' ? name.replace(/\.[^.]+$/, '') : name),
    );
    sendResponse(res, 200, true, 'OK', { names, text: names.join('\n') });
  }),
);
albumRoutes.get(
  '/photos/:photoId',
  handle(async (req, res) => {
    const access = await deliveryAccess(req.params.id, req.user!);
    if (!access.staff) await ownerAlbumAccess(req.params.id, req.user!);
    if (!isValidObjectId(req.params.photoId)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const album = await Album.findOne({ booking: req.params.id });
    const versions = access.workflow.deliveryHistory
      .filter((v: any) => v.drivePhotos?.length)
      .map((v: any) => v.version);
    const photo =
      album &&
      (await Photo.findOne({
        _id: req.params.photoId,
        album: album._id,
        ...(!access.staff ? { deliveryVersion: { $in: [0, ...versions] } } : {}),
      }));
    if (!photo) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const image = await readAlbumPhoto(photo, req.query.size === 'thumb');
    res.type(image.type).send(image.bytes);
  }),
);

publicAlbumRoutes.use(requireClientPortal);
publicAlbumRoutes.use(
  createRateLimit({
    limit: 3000,
    windowMs: 60_000,
    message: 'Quá nhiều yêu cầu album. Thử lại sau.',
  }),
);
const tokenOf = (req: { get: (name: string) => string | undefined }) =>
  req.get('X-Album-Token') || '';
publicAlbumRoutes.get(
  '/',
  handle(async (req, res) => {
    const { album } = await publicAlbumAccess(req.params.publicId, tokenOf(req));
    sendResponse(res, 200, true, 'OK', await albumDto(album));
  }),
);
publicAlbumRoutes.get(
  '/photos/:photoId',
  handle(async (req, res) => {
    const { album, workflow } = await publicAlbumAccess(req.params.publicId, tokenOf(req));
    if (!isValidObjectId(req.params.photoId)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const versions = workflow.deliveryHistory
      .filter((v: any) => v.drivePhotos?.length)
      .map((v: any) => v.version);
    const photo = await Photo.findOne({
      _id: req.params.photoId,
      album: album._id,
      deliveryVersion: { $in: [0, ...versions] },
    });
    if (!photo) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const image = await readAlbumPhoto(photo, req.query.size === 'thumb');
    res.type(image.type).send(image.bytes);
  }),
);
publicAlbumRoutes.post(
  '/:operation',
  handle(async (req, res) => {
    const operation = req.params.operation;
    if (!['photo', 'finalize'].includes(operation))
      throw new WorkflowProblem(404, 'Không tìm thấy thao tác.');
    const album = await interactAlbum(
      {
        publicId: req.params.publicId,
        token: tokenOf(req),
        expectedVersion: req.body.expectedVersion,
        key: req.get('Idempotency-Key') || '',
        operation,
        payload: req.body,
      },
      operation,
      req.body,
    );
    sendResponse(res, 200, true, 'Đã lưu.', await albumDto(album));
  }),
);

async function interactAlbum(
  input: Parameters<typeof mutateAlbum>[0],
  operation: string,
  body: Record<string, any>,
) {
  return mutateAlbum(input, async (a, workflow, session) => {
    if (operation === 'photo') {
      if (!isValidObjectId(body.photoId)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
      const photo = await Photo.findOne({ _id: body.photoId, album: a._id }).session(session);
      if (!photo || !photo.available || photo.deliveryVersion < 0)
        throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
      if (photo.deliveryVersion === 0) {
        if (a.status !== 'open' || workflow.lifecycle !== 'editing')
          throw new WorkflowProblem(409, 'Lựa chọn đã khóa. Nhờ studio mở lại để thay đổi.');
        if (body.selected !== undefined) {
          if (typeof body.selected !== 'boolean')
            throw new WorkflowProblem(400, 'Lựa chọn không hợp lệ.');
          if (body.selected && !photo.selected && a.limit) {
            const count = await Photo.countDocuments({
              album: a._id,
              deliveryVersion: 0,
              selected: true,
              available: true,
            }).session(session);
            if (count >= a.limit) throw new WorkflowProblem(409, 'Đã chọn đủ số ảnh của album.');
          }
          photo.selected = body.selected;
        }
      } else if (
        photo.deliveryVersion !== workflow.progress.deliveryVersion ||
        workflow.lifecycle !== 'delivered' ||
        body.selected !== undefined
      )
        throw new WorkflowProblem(409, 'Chỉ góp ý bản bàn giao mới nhất đang chờ nghiệm thu.');
      if (body.note !== undefined) {
        if (typeof body.note !== 'string' || body.note.trim().length > 2000)
          throw new WorkflowProblem(400, 'Ghi chú tối đa 2000 ký tự.');
        const firstDeliveryNote = photo.deliveryVersion > 0 && !photo.note && !!body.note.trim();
        photo.note = body.note.trim();
        if (firstDeliveryNote) {
          const message = `Khách góp ý ảnh ${photo.drive.name} trong bản bàn giao ${photo.deliveryVersion}.`;
          workflow.events.push({
            action: 'album.photo-note',
            message,
            audience: 'admin',
            at: new Date(),
          });
          if (workflow.events.length > 200) workflow.events.splice(0, workflow.events.length - 200);
          workflow.version++;
          await workflow.save({ session });
          await Booking.updateOne(
            { _id: a.booking },
            {
              $push: {
                events: {
                  $each: [{ message, audience: 'admin', at: new Date() }],
                  $slice: -200,
                },
              },
            },
            { session },
          );
        }
      }
      await photo.save({ session });
    } else {
      if (a.status !== 'open' || workflow.lifecycle !== 'editing')
        throw new WorkflowProblem(409, 'Lựa chọn đã khóa.');
      const chosen = await Photo.find({
        album: a._id,
        deliveryVersion: 0,
        available: true,
        selected: true,
      })
        .sort({ order: 1 })
        .session(session);
      if (!chosen.length)
        throw new WorkflowProblem(400, 'Chọn ít nhất một ảnh trước khi hoàn tất.');
      if (a.limit && chosen.length > a.limit)
        throw new WorkflowProblem(409, 'Danh sách vượt giới hạn chọn ảnh.');
      a.status = 'closed';
      a.finalizedAt = new Date();
      const round = a.selectionHistory.length + 1;
      await Selection.insertMany(
        chosen.map((p) => ({
          album: a._id,
          round,
          driveId: p.drive.id,
          name: p.drive.name,
          note: p.note,
        })),
        { session },
      );
      a.selectionHistory.push({
        at: a.finalizedAt,
        round,
        count: chosen.length,
      });
      workflow.events.push({
        action: 'album.finalize',
        message: `Khách đã chốt ${chosen.length} ảnh trong album.`,
        audience: 'admin',
        at: new Date(),
      });
      if (workflow.events.length > 200) workflow.events.splice(0, workflow.events.length - 200);
      await Booking.updateOne(
        { _id: a.booking },
        {
          $push: {
            events: {
              $each: [
                {
                  message: `Khách đã chốt ${chosen.length} ảnh trong album.`,
                  audience: 'admin',
                  at: new Date(),
                },
              ],
              $slice: -200,
            },
          },
        },
        { session },
      );
      workflow.version++;
      await workflow.save({ session });
    }
  });
}
