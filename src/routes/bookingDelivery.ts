import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, open } from 'node:fs/promises';
import { Types, isValidObjectId } from 'mongoose';
import Photo from '../models/BookingDeliveryPhoto';
import { asyncHandler } from '../middleware/asyncHandler';
import { sendResponse } from '../utils/response';
import {
  withResourceTransaction,
  WorkflowProblem,
  workflowEnabled,
} from '../services/workflowTransactions';
import {
  deliveryAccess,
  deliveryDirectory,
  deliveryFile,
  deliveryPhotoDto,
  removeDeliveryFiles,
  ensureDeliveryStorage,
} from '../services/bookingDelivery';
import { bookingDrivePhoto, readAlbumPhoto } from '../services/bookingAlbum';

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
// ponytail: current single-instance API caps concurrent disk uploads/decodes at two.
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
    await deliveryAccess(req.params.id, req.user!);
    next();
  }),
);
router.get(
  '/photos',
  handle(async (req, res) => {
    const access = await deliveryAccess(req.params.id, req.user!);
    if (!access.staff) throw new WorkflowProblem(403, 'Chỉ ekip được xem ảnh chưa bàn giao.');
    const photos = await Photo.find({
      booking: req.params.id,
      publishedVersions: { $size: 0 },
      deletedAt: { $exists: false },
    }).sort({ createdAt: 1, _id: 1 });
    sendResponse(res, 200, true, 'OK', photos.map(deliveryPhotoDto));
  }),
);
router.post(
  '/photos',
  handle(async (req, res) => {
    if (!workflowEnabled()) throw new WorkflowProblem(503, 'Chưa bật xử lý giao dịch.');
    await deliveryAccess(req.params.id, req.user!, undefined, true);
    const key = req.get('Idempotency-Key') || '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key))
      throw new WorkflowProblem(400, 'Thiếu mã tải ảnh hợp lệ.');
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
      const previous = await Photo.findOne({ booking: req.params.id, uploadKey: key }).select(
        '+sha256',
      );
      if (previous) {
        if (
          previous.deletedAt ||
          previous.sha256 !== sha256 ||
          String(previous.uploadedBy) !== String(req.user!._id)
        )
          throw new WorkflowProblem(
            409,
            'Mã tải ảnh đã được dùng cho ảnh khác hoặc ảnh đã bị xóa.',
          );
        sendResponse(res, 200, true, 'Ảnh đã được tải.', deliveryPhotoDto(previous));
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
        await deliveryAccess(req.params.id, req.user!, session, true);
        const duplicate = await Photo.findOne({ booking: req.params.id, uploadKey: key })
          .select('+sha256')
          .session(session);
        if (duplicate) {
          if (
            duplicate.deletedAt ||
            duplicate.sha256 !== sha256 ||
            String(duplicate.uploadedBy) !== String(req.user!._id)
          )
            throw new WorkflowProblem(409, 'Mã tải ảnh đã được sử dụng.');
          return duplicate;
        }
        const existing = await Photo.find({ booking: req.params.id, deletedAt: { $exists: false } })
          .select('bytes')
          .session(session);
        if (
          existing.length >= 1000 ||
          existing.reduce((sum, item) => sum + item.bytes, bytes) > 2 * 1024 ** 3
        )
          throw new WorkflowProblem(409, 'Đơn đã đạt giới hạn lưu trữ 1000 ảnh hoặc 2 GB.');
        const [created] = await Photo.create(
          [
            {
              _id: id,
              booking: req.params.id,
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
        // A failed commit acknowledgement may still commit later. Keep files for
        // delayed reconciliation unless the transaction is known to have aborted.
        if (
          !(error instanceof WorkflowProblem) &&
          error?.name !== 'ValidationError' &&
          error?.code !== 11000
        )
          preserveAttempt = true;
        throw error;
      });
      stored = String(photo._id) === idText;
      sendResponse(res, 201, true, 'Đã tải ảnh hậu kỳ.', deliveryPhotoDto(photo));
    } catch (error) {
      if (error instanceof multer.MulterError)
        throw new WorkflowProblem(400, 'Mỗi lần tải một ảnh, tối đa 20 MB.');
      throw error;
    } finally {
      active--;
      if (req.file) await unlink(req.file.path).catch(() => {});
      if (!stored && !preserveAttempt) {
        // An uncertain commit may have succeeded: never delete its referenced files.
        try {
          if (!(await Photo.exists({ _id: id }))) await removeDeliveryFiles(idText);
        } catch {
          /* Recover with delivery:cleanup after DB recovery. */
        }
      }
    }
  }),
);
router.get(
  '/photos/:photoId',
  handle(async (req, res) => {
    const access = await deliveryAccess(req.params.id, req.user!);
    if (req.params.photoId.startsWith('drive-')) {
      const photo = await bookingDrivePhoto(req.params.id, req.params.photoId.slice(6), req.user!);
      const image = await readAlbumPhoto(photo, req.query.size === 'thumb');
      res.setHeader('Cache-Control', 'no-store');
      res.type(image.type).send(image.bytes);
      return;
    }
    if (!isValidObjectId(req.params.photoId)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const photo = await Photo.findOne({
      _id: req.params.photoId,
      booking: req.params.id,
      deletedAt: { $exists: false },
      ...(!access.staff ? { 'publishedVersions.0': { $exists: true } } : {}),
    });
    if (!photo) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const file = deliveryFile(String(photo._id), req.query.size === 'thumb');
    try {
      await stat(file);
    } catch {
      throw new WorkflowProblem(404, 'Ảnh hiện chưa sẵn sàng.');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await new Promise<void>((resolve, reject) =>
      res.sendFile(file, (error) => (error ? reject(error) : resolve())),
    );
  }),
);
router.delete(
  '/photos/:photoId',
  handle(async (req, res) => {
    if (!isValidObjectId(req.params.photoId)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const photo = await withResourceTransaction(async (session) => {
      await deliveryAccess(req.params.id, req.user!, session, true);
      const found = await Photo.findOne({
        _id: req.params.photoId,
        booking: req.params.id,
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
