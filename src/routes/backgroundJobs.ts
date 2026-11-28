import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import mongoose from 'mongoose';
import { protect } from '../middleware/auth';
import { asyncHandler } from '../middleware/asyncHandler';
import Operation from '../models/BackgroundOperation';
import {
  albumOperationAccess,
  operationDto,
  shouldQueueAlbumSync,
} from '../services/backgroundOperations';
import { queueConfig } from '../config/queue';
import { getQueue, jobNames } from '../services/jobQueue';
import { sendResponse } from '../utils/response';

const router = Router();
router.use(protect);
const handle = (fn: Parameters<typeof asyncHandler>[0]) =>
  asyncHandler(async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await fn(req, res, next);
    } catch (e) {
      const status = (e as { status?: number }).status || 503;
      sendResponse(
        res,
        status,
        false,
        status < 500 ? (e as Error).message : 'Chưa thể đọc trạng thái xử lý nền.',
      );
    }
  });
router.get(
  '/operations/latest',
  handle(async (req, res) => {
    const service = String(req.query.service || ''),
      id = String(req.query.orderId || '');
    await albumOperationAccess(service, id, req.user!);
    const row = await Operation.findOne({ service, order: id }).sort({ createdAt: -1, _id: -1 });
    const visible =
      row && row.status === 'pending' && !(await shouldQueueAlbumSync()) ? null : row;
    sendResponse(res, 200, true, 'OK', visible ? operationDto(visible) : null);
  }),
);
router.get(
  '/operations/:id',
  handle(async (req, res) => {
    const row = isValidObjectId(req.params.id) ? await Operation.findById(req.params.id) : null;
    if (!row) {
      sendResponse(res, 404, false, 'Không tìm thấy tác vụ đồng bộ.');
      return;
    }
    await albumOperationAccess(row.service, String(row.order), req.user!);
    sendResponse(res, 200, true, 'OK', operationDto(row));
  }),
);
router.get(
  '/health',
  handle(async (req, res) => {
    if (!req.user!.roles.some((r) => [0, 1].includes(r))) {
      sendResponse(res, 403, false, 'Chỉ quản trị viên được xem.');
      return;
    }
    const config = queueConfig();
    if (config.mode === 'legacy') {
      sendResponse(res, 200, true, 'OK', { mode: 'legacy' });
      return;
    }
    const heartbeat = await mongoose.connection
      .collection('backgroundjobruntime')
      .findOne({ _id: 'runtime' as any });
    const counts = await Promise.all(
      jobNames.map(async (name) => {
        const queue = getQueue(name);
        const [counts, waiting] = await Promise.all([
          queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
          queue.getWaiting(0, 0),
        ]);
        return {
          name,
          counts,
          oldestWaitingAgeMs: waiting.length
            ? Math.max(0, Date.now() - waiting[0].timestamp)
            : null,
        };
      }),
    );
    sendResponse(res, 200, true, 'OK', {
      mode: 'bullmq',
      workerSeenAt: heartbeat?.workerSeenAt,
      queues: counts,
    });
  }),
);
export default router;
