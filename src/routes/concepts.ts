import { Router } from 'express';
import mongoose, { ClientSession } from 'mongoose';
import Concept from '../models/Concept';
import Package from '../models/ConceptPackage';
import Profile from '../models/PhotographerProfile';
import Settings from '../models/ConceptSettings';
import User from '../models/User';
import Costume from '../models/Costume';
import CostumeType from '../models/CostumeType';
import { protect } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import { sendResponse } from '../utils/response';
import { WorkflowProblem, withResourceTransaction } from '../services/workflowTransactions';
import {
  admin,
  availablePhotographers,
  rangeFor,
  studioFree,
  settings,
  dayString,
} from '../services/conceptBooking';
import {
  conceptEnabled,
  commandKey,
  digest,
  integer,
  objectId,
  conceptImageUrl,
  text,
} from '../services/conceptPolicy';
import { getRentalAvailability, loadRentalHolds } from '../services/rentalAvailability';
import { createRateLimit } from '../middleware/authRateLimit';

export const conceptGate: import('express').RequestHandler = (_req, res, next) => {
  if (!conceptEnabled()) {
    sendResponse(res, 404, false, 'Chưa mở đặt concept.');
    return;
  }
  next();
};
export const conceptHandler = (fn: (req: any, res: any) => Promise<void>) =>
  asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (!(error instanceof WorkflowProblem)) throw error;
      sendResponse(res, error.status, false, error.message);
    }
  });
const router = Router();
const profileTextLimits = {
  title: 120,
  tagline: 180,
  story: 4000,
  specialty: 300,
  style: 600,
  guidance: 600,
  philosophy: 1500,
};
router.use(conceptGate);
router.use(createRateLimit({ limit: 120, windowMs: 60000, message: 'Thử lại sau một phút.' }));
router.get(
  '/photographers/:id',
  conceptHandler(async (req, res) => {
    const id = objectId(req.params.id);
    const profile = await Profile.findOne({ photographer: id, published: true }).lean();
    const photographer = await User.findOne({ _id: id, roles: 3, isActive: true })
      .select('_id name')
      .lean();
    if (!profile || !photographer) throw new WorkflowProblem(404, 'Hồ sơ thợ chưa được công khai.');
    const concepts = await Concept.find({ _id: { $in: profile.concepts }, active: true })
      .select('_id name')
      .lean();
    if (!concepts.length) throw new WorkflowProblem(404, 'Hồ sơ thợ chưa được công khai.');
    const activeIds = new Set(concepts.map((c) => String(c._id)));
    sendResponse(res, 200, true, 'OK', {
      _id: String(photographer._id),
      name: photographer.name,
      bio: profile.bio,
      portraitUrl: profile.portraitUrl,
      coverUrl: profile.coverUrl,
      ...Object.fromEntries(
        Object.keys(profileTextLimits).map((field) => [field, (profile as any)[field] || '']),
      ),
      approach: profile.approach,
      audience: profile.audience,
      milestones: profile.milestones,
      concepts,
      portfolio: profile.portfolio
        .filter((p) => p.permitted && activeIds.has(String(p.concept)))
        .map((p) => ({ concept: String(p.concept), url: p.url, caption: p.caption })),
    });
  }),
);
router.get(
  '/',
  conceptHandler(async (_req, res) => {
    const concepts = await Concept.find({ active: true }).sort({ name: 1 }).lean();
    const packages = await Package.find({
      active: true,
      concept: { $in: concepts.map((c) => c._id) },
    }).lean();
    sendResponse(res, 200, true, 'OK', { concepts, packages, settings: await settings() });
  }),
);
router.get(
  '/availability',
  conceptHandler(async (req, res) => {
    const pkg = await Package.findOne({ _id: objectId(req.query.packageId), active: true }).lean();
    if (!pkg || !(await Concept.exists({ _id: pkg.concept, active: true })))
      throw new WorkflowProblem(404, 'Không tìm thấy gói.');
    const day = text(req.query.day, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || dayString(new Date(`${day}T00:00:00+07:00`)) !== day)
      throw new WorkflowProblem(400, 'Ngày không hợp lệ.');
    const cfg = await settings();
    const slots = [];
    for (
      let m = cfg.openMinutes;
      m + pkg.durationMinutes <= cfg.closeMinutes;
      m += cfg.stepMinutes
    ) {
      const startAt = `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+07:00`;
      try {
        const { start, end } = await rangeFor(pkg, startAt);
        if (!(await studioFree(start, end, cfg.bufferMinutes))) continue;
        const photographers = await availablePhotographers(pkg, start, end);
        if (photographers.length)
          slots.push({ startAt: start.toISOString(), endAt: end.toISOString(), photographers });
      } catch (error) {
        if (!(error instanceof WorkflowProblem) || error.status !== 400) throw error;
      }
    }
    sendResponse(res, 200, true, 'OK', { day, available: !!slots.length, slots });
  }),
);
router.get(
  '/costumes',
  conceptHandler(async (req, res) => {
    const pkg = await Package.findOne({ _id: objectId(req.query.packageId), active: true }).lean();
    if (!pkg) throw new WorkflowProblem(404, 'Không tìm thấy gói.');
    const { start, end } = await rangeFor(pkg, req.query.startAt);
    const rows = await Costume.find({
      type: { $in: pkg.costumeTypes },
      itemKind: 'clothing',
    }).lean();
    const holds = await loadRentalHolds(rows.map((r) => String(r._id)));
    sendResponse(
      res,
      200,
      true,
      'OK',
      rows.map((r) => ({
        _id: r._id,
        name: r.name,
        available: getRentalAvailability(
          r,
          { receiveDate: start, returnDate: end },
          holds.orders,
          holds.schedules,
        ),
      })),
    );
  }),
);
router.use(protect);
router.use((req, res, next) => {
  if (!admin(req.user)) {
    sendResponse(res, 403, false, 'Chỉ quản trị được sửa danh mục.');
    return;
  }
  next();
});
router.get(
  '/manage',
  conceptHandler(async (_req, res) => {
    sendResponse(res, 200, true, 'OK', {
      concepts: await Concept.find().lean(),
      packages: await Package.find().lean(),
      profiles: await Profile.find().lean(),
      photographers: await User.find({ roles: 3, isActive: true })
        .select('_id name username')
        .lean(),
      costumeTypes: await CostumeType.find().select('_id name').lean(),
      settings: await settings(),
    });
  }),
);
router.post(
  '/:kind',
  conceptHandler(async (req, res) => {
    const { kind } = req.params,
      b = req.body;
    const key = commandKey(req.get('Idempotency-Key'));
    const fingerprint = digest({ kind, body: b });
    await withResourceTransaction(async (session: ClientSession) => {
      const receipts = mongoose.connection.collection('conceptcatalogcommands');
      const receiptId = `${req.user._id}:${key}`;
      const prior = await receipts.findOne({ _id: receiptId as any }, { session });
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new WorkflowProblem(409, 'Khóa đã dùng cho nội dung khác.');
        return;
      }
      await receipts.insertOne({ _id: receiptId as any, fingerprint, at: new Date() }, { session });
      if (kind === 'settings') {
        const openMinutes = integer(b.openMinutes, 0, 1439),
          closeMinutes = integer(b.closeMinutes, 1, 1440);
        if (
          closeMinutes <= openMinutes ||
          !Array.isArray(b.closedWeekdays) ||
          b.closedWeekdays.length > 7
        )
          throw new WorkflowProblem(400, 'Giờ mở cửa không hợp lệ.');
        const cfg = await settings(session);
        if (b.expectedVersion !== cfg.version)
          throw new WorkflowProblem(409, 'Cấu hình đã thay đổi.');
        await Settings.updateOne(
          { _id: 'studio' },
          {
            $set: {
              openMinutes,
              closeMinutes,
              stepMinutes: integer(b.stepMinutes, 5, 120),
              bufferMinutes: integer(b.bufferMinutes, 0, 180),
              horizonDays: integer(b.horizonDays, 1, 365),
              closedWeekdays: b.closedWeekdays.map((v: unknown) => integer(v, 0, 6)),
              version: cfg.version + 1,
            },
          },
          { upsert: true, session },
        );
        return;
      }
      let model: any, data: any;
      if (kind === 'concept') {
        model = Concept;
        data = {
          name: text(b.name, 120),
          description: text(b.description, 4000, false),
          coverUrl: b.coverUrl ? conceptImageUrl(b.coverUrl) : '',
          active: b.active === true,
        };
        for (const [field, max] of Object.entries({
          story: 6000,
          styleSummary: 300,
          audience: 1000,
          setting: 1000,
          wardrobeGuidance: 1000,
          preparation: 2000,
        }))
          if (b[field] !== undefined) data[field] = text(b[field], max, false);
        if (b.gallery !== undefined) {
          if (!Array.isArray(b.gallery) || b.gallery.length > 24)
            throw new WorkflowProblem(400, 'Bộ ảnh tham khảo tối đa 24 ảnh.');
          data.gallery = b.gallery.map((image: any) => ({
            url: conceptImageUrl(image?.url),
            caption: text(image?.caption, 200, false),
          }));
        }
      } else if (kind === 'package') {
        model = Package;
        const concept = objectId(b.concept);
        if (!(await Concept.exists({ _id: concept }).session(session)))
          throw new WorkflowProblem(400, 'Concept không tồn tại.');
        if (!Array.isArray(b.costumeTypes) || b.costumeTypes.length > 100)
          throw new WorkflowProblem(400, 'Loại trang phục không hợp lệ.');
        const costumeTypes = [...new Set<string>(b.costumeTypes.map(objectId))];
        if (
          (await CostumeType.countDocuments({ _id: { $in: costumeTypes } }).session(session)) !==
          costumeTypes.length
        )
          throw new WorkflowProblem(400, 'Loại trang phục không tồn tại.');
        data = {
          concept,
          name: text(b.name, 120),
          price: integer(b.price, 1000, 100000000),
          durationMinutes: integer(b.durationMinutes, 30, 600),
          maxPeople: integer(b.maxPeople, 1, 100),
          retouchQuota: integer(b.retouchQuota, 1, 500),
          extraPhotoPrice: integer(b.extraPhotoPrice, 1, 100000000),
          costumeCount: integer(b.costumeCount, 0, 100),
          costumeTypes,
          active: b.active === true,
        };
        if (b.imageUrl !== undefined) data.imageUrl = b.imageUrl ? conceptImageUrl(b.imageUrl) : '';
        if (b.introduction !== undefined) data.introduction = text(b.introduction, 1000, false);
        if (b.studioSupport !== undefined) {
          if (!Array.isArray(b.studioSupport) || b.studioSupport.length > 4)
            throw new WorkflowProblem(400, 'Tối đa bốn nội dung studio đồng hành.');
          data.studioSupport = b.studioSupport.map((item: any) => ({
            title: text(item?.title, 120),
            description: text(item?.description, 500),
          }));
        }
        if (b.delivery !== undefined) {
          if (!b.delivery || typeof b.delivery !== 'object' || Array.isArray(b.delivery))
            throw new WorkflowProblem(400, 'Thông tin giao ảnh không hợp lệ.');
          data.delivery = Object.fromEntries(
            ['timeline', 'format', 'originals'].map((field) => [
              field,
              text(b.delivery[field], 1000, false),
            ]),
          );
        }
        if (b.showcase !== undefined) {
          if (
            !b.showcase ||
            typeof b.showcase !== 'object' ||
            Array.isArray(b.showcase) ||
            !Array.isArray(b.showcase.images) ||
            b.showcase.images.length > 6
          )
            throw new WorkflowProblem(400, 'Bộ ảnh giới thiệu tối đa sáu ảnh.');
          data.showcase = {
            title: text(b.showcase.title, 120, false),
            description: text(b.showcase.description, 1000, false),
            images: b.showcase.images.map((image: any) => ({
              url: conceptImageUrl(image?.url),
              caption: text(image?.caption, 200, false),
            })),
          };
        }
        if (b.decor !== undefined) {
          if (!b.decor || typeof b.decor !== 'object' || Array.isArray(b.decor))
            throw new WorkflowProblem(400, 'Thông tin decor không hợp lệ.');
          data.decor = Object.fromEntries(
            ['backdrop', 'props', 'layout', 'included'].map((field) => [
              field,
              text(b.decor[field], 1000, false),
            ]),
          );
        }
      } else if (kind === 'profile') {
        model = Profile;
        const photographer = objectId(b.photographer);
        if (!(await User.exists({ _id: photographer, roles: 3, isActive: true }).session(session)))
          throw new WorkflowProblem(400, 'Thợ không hợp lệ.');
        if (
          !Array.isArray(b.concepts) ||
          b.concepts.length > 100 ||
          !Array.isArray(b.portfolio) ||
          b.portfolio.length > 100
        )
          throw new WorkflowProblem(400, 'Danh sách không hợp lệ.');
        const concepts = [...new Set<string>(b.concepts.map(objectId))];
        if (
          (await Concept.countDocuments({ _id: { $in: concepts } }).session(session)) !==
          concepts.length
        )
          throw new WorkflowProblem(400, 'Concept không tồn tại.');
        data = {
          photographer,
          concepts,
          bio: text(b.bio, 2000, false),
          published: b.published === true,
          portfolio: b.portfolio.map((p: any) => {
            if (!concepts.includes(p.concept) || p.permitted !== true)
              throw new WorkflowProblem(
                400,
                'Ảnh portfolio phải đúng concept và được phép công khai.',
              );
            return {
              concept: p.concept,
              url: conceptImageUrl(p.url),
              caption: text(p.caption, 200, false),
              permitted: true,
            };
          }),
        };
        for (const [field, max] of Object.entries(profileTextLimits))
          if (b[field] !== undefined) data[field] = text(b[field], max, false);
        for (const field of ['portraitUrl', 'coverUrl'])
          if (b[field] !== undefined) data[field] = b[field] ? conceptImageUrl(b[field]) : '';
        for (const [field, max] of Object.entries({ approach: 4, audience: 4, milestones: 6 })) {
          if (b[field] === undefined) continue;
          if (!Array.isArray(b[field]) || b[field].length > max)
            throw new WorkflowProblem(400, 'Nội dung hồ sơ không hợp lệ.');
          data[field] = b[field].map((item: any) => ({
            title: text(item?.title, 120),
            description: text(item?.description, 600, false),
          }));
        }
      } else throw new WorkflowProblem(404, 'Không có danh mục này.');
      if (b.id) {
        const old = await model.findById(objectId(b.id)).session(session);
        if (!old) throw new WorkflowProblem(404, 'Không tìm thấy mục.');
        if (kind === 'package' && old.version !== b.expectedVersion)
          throw new WorkflowProblem(409, 'Gói đã thay đổi.');
        Object.assign(old, data);
        if (kind === 'package') old.version += 1;
        await old.save({ session });
      } else await model.create([data], { session });
    });
    sendResponse(res, 200, true, 'Đã lưu.');
  }),
);
export default router;
