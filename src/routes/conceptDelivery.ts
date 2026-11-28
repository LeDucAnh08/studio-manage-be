import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, open } from 'node:fs/promises';
import { Types, isValidObjectId } from 'mongoose';
import ConceptAlbum from '../models/ConceptAlbum';
import Photo from '../models/ConceptDeliveryPhoto';
import { asyncHandler } from '../middleware/asyncHandler';
import { sendResponse } from '../utils/response';
import {
  withResourceTransaction,
  WorkflowProblem,
  workflowEnabled,
} from '../services/workflowTransactions';
import {
  deliveryDirectory,
  deliveryFile,
  ensureDeliveryStorage,
  removeDeliveryFiles,
  sendDeliveryPhoto,
} from '../services/bookingDelivery';
import {
  conceptDeliveryAccess,
  conceptDeliveryPhotoDto,
  validateConceptReplacementOriginals,
} from '../services/conceptDelivery';

const router = Router({ mergeParams: true });
const stage = () => path.join(deliveryDirectory(), '.staging');
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdir(stage(), { recursive: true }).then(
        () => cb(null, stage()),
        (error) => cb(error as Error, ''),
      );
    },
    filename: (_req, _file, cb) => cb(null, randomUUID()),
  }),
  limits: { files: 1, fileSize: 20 * 1024 * 1024, fields: 0, parts: 1 },
});
let active = 0;

const handle = (work: Parameters<typeof asyncHandler>[0]) =>
  asyncHandler(async (req, res, next) => {
    try {
      await work(req, res, next);
    } catch (error) {
      if (res.headersSent || req.aborted) return;
      const problem = error as WorkflowProblem;
      sendResponse(
        res,
        problem.status || 500,
        false,
        problem.status ? problem.message : 'Chưa thể xử lý ảnh bàn giao.',
      );
    }
  });

router.use(
  handle(async (req, _res, next) => {
    await conceptDeliveryAccess(req.params.id, req.user!);
    next();
  }),
);

router.get(
  '/photos',
  handle(async (req, res) => {
    const access = await conceptDeliveryAccess(req.params.id, req.user!);
    if (!access.staff) throw new WorkflowProblem(403, 'Chỉ ekip được xem ảnh chưa bàn giao.');
    const photos = await Photo.find({
      order: req.params.id,
      originalPhotoId: { $exists: false },
      publishedVersions: { $size: 0 },
      deletedAt: { $exists: false },
    }).sort({ createdAt: 1, _id: 1 });
    sendResponse(res, 200, true, 'OK', photos.map(conceptDeliveryPhotoDto));
  }),
);

router.post(
  '/photos',
  handle(async (req, res) => {
    if (!workflowEnabled()) throw new WorkflowProblem(503, 'Chưa bật xử lý giao dịch.');
    await conceptDeliveryAccess(req.params.id, req.user!, undefined, true);
    const key = req.get('Idempotency-Key') || '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
      throw new WorkflowProblem(400, 'Thiếu mã tải ảnh hợp lệ.');
    const originalPhotoId = req.query.originalPhotoId;
    if (
      originalPhotoId !== undefined &&
      (typeof originalPhotoId !== 'string' || !/^[a-f0-9]{24}$/.test(originalPhotoId))
    )
      throw new WorkflowProblem(400, 'Mã ảnh gốc không hợp lệ.');
    await ensureDeliveryStorage();
    if (active >= 2) {
      res.setHeader('Retry-After', '3');
      throw new WorkflowProblem(429, 'Máy chủ đang xử lý ảnh. Vui lòng thử lại sau vài giây.');
    }
    active++;
    const id = new Types.ObjectId(),
      idText = String(id);
    let stored = false;
    let preserveAttempt = false;
    try {
      await new Promise<void>((resolve, reject) =>
        upload.single('photo')(req, res, (error) => (error ? reject(error) : resolve())),
      );
      const file = req.file;
      if (!file) throw new WorkflowProblem(400, 'Chọn một ảnh JPEG, PNG hoặc WebP, tối đa 20 MB.');
      const source = await open(file.path, 'r');
      const signature = Buffer.alloc(12);
      try {
        await source.read(signature, 0, 12, 0);
      } finally {
        await source.close();
      }
      if (
        !(
          signature.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
          signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (signature.toString('ascii', 0, 4) === 'RIFF' &&
            signature.toString('ascii', 8, 12) === 'WEBP')
        )
      )
        throw new WorkflowProblem(400, 'Chỉ nhận ảnh JPEG, PNG hoặc WebP hợp lệ.');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file.path)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      const previous = await Photo.findOne({ order: req.params.id, uploadKey: key }).select(
        '+sha256',
      );
      if (previous) {
        if (
          previous.deletedAt ||
          previous.sha256 !== sha256 ||
          String(previous.originalPhotoId ?? '') !== (originalPhotoId ?? '') ||
          String(previous.uploadedBy) !== String(req.user!._id)
        )
          throw new WorkflowProblem(
            409,
            'Mã tải ảnh đã được dùng cho ảnh khác hoặc ảnh đã bị xóa.',
          );
        sendResponse(res, 200, true, 'Ảnh đã được tải.', conceptDeliveryPhotoDto(previous));
        return;
      }
      try {
        const image = sharp(file.path, { limitInputPixels: 60_000_000, animated: false });
        const metadata = await image.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1)
          throw new Error('format');
        await image
          .rotate()
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 95, mozjpeg: true })
          .toFile(deliveryFile(idText));
        await sharp(deliveryFile(idText))
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(deliveryFile(idText, true));
      } catch {
        throw new WorkflowProblem(
          400,
          'Ảnh không hợp lệ. Chỉ nhận JPEG, PNG, WebP tĩnh, tối đa 60 megapixel.',
        );
      }
      const info = await sharp(deliveryFile(idText)).metadata();
      const bytes =
        (await stat(deliveryFile(idText))).size + (await stat(deliveryFile(idText, true))).size;
      if (bytes > 40 * 1024 * 1024)
        throw new WorkflowProblem(
          400,
          'Ảnh sau xử lý quá lớn. Vui lòng xuất ảnh dung lượng nhỏ hơn.',
        );
      const photo = await withResourceTransaction(async (session) => {
        const { order } = await conceptDeliveryAccess(req.params.id, req.user!, session, true);
        const duplicate = await Photo.findOne({ order: req.params.id, uploadKey: key })
          .select('+sha256')
          .session(session);
        if (duplicate) {
          if (
            duplicate.deletedAt ||
            duplicate.sha256 !== sha256 ||
            String(duplicate.originalPhotoId ?? '') !== (originalPhotoId ?? '') ||
            String(duplicate.uploadedBy) !== String(req.user!._id)
          )
            throw new WorkflowProblem(409, 'Mã tải ảnh đã được sử dụng.');
          return duplicate;
        }
        if (originalPhotoId) {
          await validateConceptReplacementOriginals(req.params.id, [originalPhotoId], session);
          await Photo.updateMany(
            {
              order: req.params.id,
              originalPhotoId,
              publishedVersions: { $size: 0 },
              deletedAt: { $exists: false },
            },
            { $set: { deletedAt: new Date() } },
            { session },
          );
        }
        const existing = await Photo.find({ order: req.params.id, deletedAt: { $exists: false } })
          .select('bytes originalPhotoId publishedVersions')
          .session(session);
        if (
          originalPhotoId &&
          existing.filter((item) => item.originalPhotoId && !item.publishedVersions.length)
            .length >= 500
        )
          throw new WorkflowProblem(409, 'Mỗi bản bàn giao nhận tối đa 500 ảnh chỉnh sửa.');
        if (
          existing.length >= 1000 ||
          existing.reduce((sum, item) => sum + item.bytes, bytes) > 2 * 1024 ** 3
        )
          throw new WorkflowProblem(409, 'Đơn đã đạt giới hạn lưu trữ 1000 ảnh hoặc 2 GB.');
        let album = await ConceptAlbum.findOne({ order: req.params.id }).session(session);
        if (!album) {
          [album] = await ConceptAlbum.create(
            [{ order: req.params.id, title: order.snapshot.name }],
            { session },
          );
        }
        const [created] = await Photo.create(
          [
            {
              _id: id,
              album: album._id,
              order: req.params.id,
              originalPhotoId,
              uploadedBy: req.user!._id,
              uploadKey: key,
              sha256,
              name:
                file.originalname.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 160) || 'Ảnh hậu kỳ',
              width: info.width,
              height: info.height,
              bytes,
            },
          ],
          { session },
        );
        return created;
      }).catch((error) => {
        if (
          !(error instanceof WorkflowProblem) &&
          error?.name !== 'ValidationError' &&
          error?.code !== 11000
        )
          preserveAttempt = true;
        throw error;
      });
      stored = String(photo._id) === idText;
      sendResponse(res, 201, true, 'Đã tải ảnh hậu kỳ.', conceptDeliveryPhotoDto(photo));
    } catch (error) {
      if (error instanceof multer.MulterError)
        throw new WorkflowProblem(400, 'Mỗi lần tải một ảnh, tối đa 20 MB.');
      throw error;
    } finally {
      active--;
      if (req.file) await unlink(req.file.path).catch(() => {});
      if (!stored && !preserveAttempt) {
        try {
          if (!(await Photo.exists({ _id: id }))) await removeDeliveryFiles(idText);
        } catch {
          /* ignore */
        }
      }
    }
  }),
);

router.get(
  '/photos/:photoId',
  handle(async (req, res) => {
    const access = await conceptDeliveryAccess(req.params.id, req.user!);
    if (!isValidObjectId(req.params.photoId)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const photo = await Photo.findOne({
      _id: req.params.photoId,
      order: req.params.id,
      deletedAt: { $exists: false },
      ...(!access.staff ? { 'publishedVersions.0': { $exists: true } } : {}),
    });
    if (!photo) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    if (req.query.download === 'true') {
      if (!access.staff) {
        const album = await ConceptAlbum.findOne({ order: req.params.id }).select('allowDownload');
        if (!album?.allowDownload || !photo.publishedVersions.length)
          throw new WorkflowProblem(403, 'Không được tải ảnh.');
      }
      res.attachment(photo.name.replace(/[\r\n/\\]/g, '_'));
    }
    await sendDeliveryPhoto(res, String(photo._id), req.query.size === 'thumb');
  }),
);

router.delete(
  '/photos/:photoId',
  handle(async (req, res) => {
    if (!isValidObjectId(req.params.photoId)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const photo = await withResourceTransaction(async (session) => {
      await conceptDeliveryAccess(req.params.id, req.user!, session, true);
      const found = await Photo.findOne({
        _id: req.params.photoId,
        order: req.params.id,
      }).session(session);
      if (!found) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
      if (found.publishedVersions.length)
        throw new WorkflowProblem(409, 'Không xóa ảnh đã bàn giao.');
      if (!found.deletedAt) {
        found.deletedAt = new Date();
        await found.save({ session });
      }
      return found;
    });
    await removeDeliveryFiles(String(photo._id));
    sendResponse(res, 200, true, 'Đã xóa ảnh nháp.');
  }),
);

export default router;
