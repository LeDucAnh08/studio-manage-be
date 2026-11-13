import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import sharp from 'sharp';
import Profile from '../models/PhotographerProfile';
import User from '../models/User';
import Concept from '../models/Concept';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { asyncHandler } from '../middleware/asyncHandler';
import { createRateLimit } from '../middleware/authRateLimit';
import { conceptEnabled, objectId } from '../services/conceptPolicy';
import { WorkflowProblem } from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';
import {
  assertPublishable,
  expectedRevision,
  portfolioMediaUrl,
  portfolioState,
  profileImages,
  publicPortfolio,
  revisionFilter,
  validateProfileContent,
} from '../services/photographerPortfolio';

export const portfolioDirectory = () =>
  path.resolve(
    process.env.PORTFOLIO_UPLOAD_DIR || path.join(__dirname, '../../../.data/portfolio-media'),
  );
const router = Router();
const handle = (work: Parameters<typeof asyncHandler>[0]) =>
  asyncHandler(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await work(req, res, next);
    } catch (error) {
      if (error instanceof WorkflowProblem) {
        sendResponse(res, error.status, false, error.message);
        return;
      }
      if ((error as { code?: number }).code === 11000) {
        sendResponse(res, 409, false, 'Hồ sơ đã thay đổi. Hãy tải lại.');
        return;
      }
      throw error;
    }
  });
router.use(['/me/portfolio', '/:id/portfolio', '/:id/portfolio-media/:file'], (_req, res, next) => {
  if (!conceptEnabled()) {
    sendResponse(res, 404, false, 'Chưa mở portfolio concept.');
    return;
  }
  next();
});
const validFile = (file: string) => /^[a-f0-9-]{36}\.webp$/.test(file);
router.get(
  '/:id/portfolio-media/:file',
  handle(async (req, res, next) => {
    const owner = objectId(req.params.id),
      file = req.params.file;
    if (!validFile(file)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    const profile = await Profile.findOne({ photographer: owner }).lean();
    const url = portfolioMediaUrl(owner, file);
    const activeUser = await User.exists({ _id: owner, roles: 3, isActive: true });
    const activeConcepts = await Concept.find({
      _id: { $in: profile?.concepts || [] },
      active: true,
    })
      .select('_id')
      .lean();
    const allowed = new Set(activeConcepts.map((c) => String(c._id)));
    const publicImages = [
      profile?.portraitUrl,
      profile?.coverUrl,
      ...(profile?.portfolio || [])
        .filter((p) => p.permitted && allowed.has(String(p.concept)))
        .map((p) => p.url),
    ];
    if (activeUser && profile?.published && allowed.size && publicImages.includes(url)) {
      res.sendFile(path.join(portfolioDirectory(), owner, file), (error) => {
        if (error && !res.headersSent) res.status(404).end();
      });
      return;
    }
    // Draft media needs the owner's Bearer token; never expose drafts through static hosting.
    if (!req.headers.authorization) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
    await protect(req, res, () => {
      if (
        String(req.user!._id) !== owner ||
        !req.user!.roles.includes(3) ||
        ![...profileImages(profile), ...profileImages(profile?.draft)].includes(url)
      ) {
        sendResponse(res, 404, false, 'Không tìm thấy ảnh.');
        return;
      }
      res.sendFile(path.join(portfolioDirectory(), owner, file), (error) => {
        if (error && !res.headersSent) res.status(404).end();
      });
    });
  }),
);
const receive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10, fields: 1, fieldSize: 300 * 1024, parts: 11 },
}).array('images', 10);
router.use('/me/portfolio', protect, requireRole(3));
router.get(
  '/me/portfolio',
  handle(async (req, res) => {
    sendResponse(
      res,
      200,
      true,
      'OK',
      await portfolioState(String(req.user!._id), req.user!.name || req.user!.username),
    );
  }),
);
router.use(
  '/me/portfolio',
  createRateLimit({
    limit: 20,
    windowMs: 60000,
    message: 'Bạn đang lưu quá nhanh. Vui lòng thử lại sau một phút.',
  }),
);
router.use('/me/portfolio', (req, res, next) => {
  if (!['PUT', 'POST'].includes(req.method)) {
    next();
    return;
  }
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
        'Tối đa 10 ảnh mới mỗi lần lưu, 5 MB/ảnh.',
      );
      return;
    }
    next();
  });
});
async function removeUnused(owner: string, urls: string[]) {
  const latest = await Profile.findOne({ photographer: owner }).lean();
  const referenced = new Set([...profileImages(latest), ...profileImages(latest?.draft)]);
  for (const url of urls) {
    const file = url.split('/').pop()!;
    if (url !== portfolioMediaUrl(owner, file) || !validFile(file) || referenced.has(url)) continue;
    try {
      await unlink(path.join(portfolioDirectory(), owner, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('Không xóa được ảnh portfolio:', error);
    }
  }
}
const save = handle(async (req, res) => {
  let body: any;
  try {
    body = JSON.parse(req.body.content);
  } catch {
    throw new WorkflowProblem(400, 'Nội dung hồ sơ không hợp lệ.');
  }
  const revision = expectedRevision(body?.revision),
    owner = String(req.user!._id);
  const old = await Profile.findOne({ photographer: owner }).lean();
  if ((old?.revision || 0) !== revision)
    throw new WorkflowProblem(409, 'Hồ sơ đã thay đổi ở nơi khác. Hãy tải lại trước khi lưu.');
  const uploads: string[] = [];
  const files = (req.files || []) as Express.Multer.File[];
  try {
    for (const file of files) {
      let output: Buffer;
      try {
        const image = sharp(file.buffer, { limitInputPixels: 24_000_000, animated: false });
        const meta = await image.metadata();
        if (!['jpeg', 'png', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1)
          throw new Error();
        output = await image
          .rotate()
          .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
      } catch {
        throw new WorkflowProblem(400, 'Chỉ nhận ảnh JPEG, PNG, WebP tĩnh, tối đa 24 megapixel.');
      }
      const name = `${randomUUID()}.webp`;
      await mkdir(path.join(portfolioDirectory(), owner), { recursive: true });
      uploads.push(portfolioMediaUrl(owner, name));
      await writeFile(path.join(portfolioDirectory(), owner, name), output, { flag: 'wx' });
    }
    const input = body.content;
    if (!input || typeof input !== 'object')
      throw new WorkflowProblem(400, 'Nội dung hồ sơ không hợp lệ.');
    const used = new Set<number>();
    const resolve = (url: any) => {
      if (typeof url !== 'string' || !url.startsWith('upload:')) return url;
      const index = Number(url.slice(7));
      if (!/^upload:\d+$/.test(url) || !uploads[index])
        throw new WorkflowProblem(400, 'Ảnh tải lên không hợp lệ.');
      used.add(index);
      return uploads[index];
    };
    input.portraitUrl = resolve(input.portraitUrl);
    input.coverUrl = resolve(input.coverUrl);
    if (Array.isArray(input.portfolio))
      input.portfolio = input.portfolio.map((p: any) => ({ ...p, url: resolve(p?.url) }));
    if (used.size !== files.length)
      throw new WorkflowProblem(400, 'Có ảnh tải lên chưa được sử dụng.');
    const images = new Set([...profileImages(old), ...profileImages(old?.draft), ...uploads]);
    const content = validateProfileContent(input, (old?.concepts || []).map(String), images);
    const publish = req.path.endsWith('/publish');
    if (publish) {
      const concepts = await Concept.find({ _id: { $in: old?.concepts || [] }, active: true })
        .select('_id')
        .lean();
      assertPublishable(
        content,
        concepts.map((c) => String(c._id)),
      );
    }
    const data = {
      draft: content,
      revision: revision + 1,
      ...(publish ? { ...content, published: true, publishedRevision: revision + 1 } : {}),
    };
    if (old) {
      const saved = await Profile.updateOne(
        { _id: old._id, ...revisionFilter(revision) },
        { $set: data },
        { runValidators: true },
      );
      if (!saved.matchedCount) throw new WorkflowProblem(409, 'Hồ sơ đã thay đổi. Hãy tải lại.');
    } else await Profile.create({ photographer: owner, ...data });
    sendResponse(
      res,
      200,
      true,
      publish ? 'Đã công khai portfolio.' : 'Đã lưu nháp.',
      await portfolioState(owner, req.user!.name || req.user!.username),
    );
  } finally {
    // Re-read persisted references even after ambiguous write errors; never delete live images.
    await removeUnused(owner, [
      ...uploads,
      ...profileImages(old),
      ...profileImages(old?.draft),
    ]).catch((error) => console.error('Portfolio cleanup:', error));
  }
});
router.put('/me/portfolio', save);
router.post('/me/portfolio/publish', save);
router.get(
  '/:id/portfolio',
  handle(async (req, res) => {
    sendResponse(res, 200, true, 'OK', await publicPortfolio(objectId(req.params.id)));
  }),
);
export default router;
