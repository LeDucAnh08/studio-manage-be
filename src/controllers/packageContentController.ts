import { Request, Response, RequestHandler } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import Package from '../models/Package';
import PackageDetail from '../models/PackageDetail';
import { attachPackageDetails, savePackageDetails } from '../services/packageDetails';
import { WorkflowProblem } from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';
import { readPackageContent } from '../utils/packageContentInput';
import { deletePackageImages, storePackageImage } from '../services/packageMedia';
import type { PackageImage } from '../types/packageContent';

const PUBLIC_FIELDS =
  'name pricePerMember depositPercent depositHoldHours updatedAt duration crewRatio editingScope deliveryDays studentsPerCrew description costumes isPopular detailsVersion';

export const validatePackageId: RequestHandler = (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    sendResponse(res, 400, false, 'Mã gói dịch vụ không hợp lệ.');
    return;
  }
  next();
};

const receive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10, fields: 1, fieldSize: 100 * 1024, parts: 11 },
}).array('images', 10);

export const receivePackageContent: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) {
    sendResponse(res, 400, false, 'Gửi nội dung bằng multipart/form-data.');
    return;
  }
  receive(req, res, (error) => {
    if (error) {
      sendResponse(
        res,
        error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        false,
        'Không nhận được ảnh. Tối đa 10 ảnh, 5 MB/ảnh và 100 KB nội dung.',
      );
      return;
    }
    next();
  });
};

export async function getPublicPackage(req: Request, res: Response): Promise<void> {
  const pkg = await Package.findById(req.params.id)
    .select(PUBLIC_FIELDS)
    .populate('costumes', 'name')
    .lean();
  if (!pkg) {
    sendResponse(res, 404, false, 'Gói dịch vụ không còn tồn tại.');
    return;
  }
  try {
    sendResponse(res, 200, true, 'OK', await attachPackageDetails(pkg));
  } catch (error) {
    if (!(error instanceof WorkflowProblem)) throw error;
    sendResponse(res, error.status, false, error.message);
  }
}

export async function updatePackageContent(req: Request, res: Response): Promise<void> {
  const files = (req.files || []) as Express.Multer.File[];
  let parsed: ReturnType<typeof readPackageContent>;
  try {
    parsed = readPackageContent(JSON.parse(req.body.content), files.length);
  } catch (error) {
    sendResponse(
      res,
      400,
      false,
      error instanceof SyntaxError ? 'Nội dung JSON không hợp lệ.' : (error as Error).message,
    );
    return;
  }
  const previousPackage = await Package.findById(req.params.id).lean();
  if (!previousPackage) {
    sendResponse(res, 404, false, 'Gói dịch vụ không còn tồn tại.');
    return;
  }
  let previous;
  try {
    previous = await attachPackageDetails(previousPackage);
  } catch (error) {
    if (!(error instanceof WorkflowProblem)) throw error;
    sendResponse(res, error.status, false, error.message);
    return;
  }
  if ((previous.detailsVersion || 0) !== parsed.version) {
    sendResponse(
      res,
      409,
      false,
      'Nội dung đã được thay đổi ở nơi khác. Hãy tải lại trước khi lưu.',
    );
    return;
  }
  const oldImages = previous.details?.gallery || [];
  if (
    parsed.details.gallery.some(
      (image) => image.id && !oldImages.some((old) => old.id === image.id),
    )
  ) {
    sendResponse(res, 400, false, 'Ảnh không thuộc gói dịch vụ này.');
    return;
  }
  const stored: PackageImage[] = [];
  let committed = false;
  let writeAttempted = false;
  try {
    for (const file of files) stored.push(await storePackageImage(file));
    const gallery = parsed.details.gallery.map((image) => ({
      ...(image.id ? oldImages.find((old) => old.id === image.id)! : stored[image.uploadIndex!]),
      alt: image.alt,
      caption: image.caption,
    }));
    writeAttempted = true;
    const saved = await savePackageDetails(req.params.id, parsed.version, {
      ...parsed.details,
      gallery,
    });
    committed = true;
    // The editor does not need costumes; avoid a second DB query after committing media references.
    delete saved.costumes;
    await deletePackageImages(
      oldImages
        .filter((old) => !gallery.some((image) => image.id === old.id))
        .map((image) => image.id),
    );
    sendResponse(res, 200, true, 'Đã lưu nội dung chi tiết.', saved);
  } catch (error) {
    if (error instanceof WorkflowProblem) {
      sendResponse(res, error.status, false, error.message);
      return;
    }
    if ((error as NodeJS.ErrnoException).code) throw error;
    if ((error as Error).message.startsWith('Ảnh không hợp lệ')) {
      sendResponse(res, 400, false, (error as Error).message);
      return;
    }
    throw error;
  } finally {
    if (!committed && stored.length) {
      let removable = stored;
      if (writeAttempted) {
        try {
          // A connection error may happen after MongoDB committed the update.
          // Never remove an image that the persisted package already references.
          const latest = await PackageDetail.findOne({ package: req.params.id })
            .select('gallery')
            .lean();
          removable = stored.filter(
            (image) => !latest?.gallery.some((saved) => saved.id === image.id),
          );
        } catch {
          // ponytail: retain uncertain files during a DB outage; reconcile unreferenced media if storage grows.
          removable = [];
          console.error(
            'Chưa xác minh được ảnh gói sau lỗi ghi dữ liệu; giữ file để tránh mất ảnh.',
          );
        }
      }
      await deletePackageImages(removable.map((image) => image.id));
    }
  }
}
