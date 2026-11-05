import { Router, raw } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticateSePay, ingestSePayPayload } from '../services/sepay';
import { WorkflowProblem } from '../services/workflowTransactions';
import SePayReceipt from '../models/SePayReceipt';
import { boundedInteger } from '../utils/input';
import { sendResponse } from '../utils/response';

const router = Router();
// Mount this router before the global JSON parser: signatures cover original bytes.
router.post(
  '/sepay/webhook',
  raw({ type: 'application/json', limit: '32kb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new WorkflowProblem(400, 'JSON raw body required');
      authenticateSePay(req.body, req.get('X-SePay-Signature'), req.get('X-SePay-Timestamp'));
      let payload: unknown;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        throw new WorkflowProblem(400, 'Invalid JSON');
      }
      await ingestSePayPayload(payload);
      res.status(200).json({ success: true });
    } catch (error) {
      const status = error instanceof WorkflowProblem ? error.status : 500;
      if (status >= 500)
        console.error(
          '[SePay] webhook failed; provider should retry',
          error instanceof WorkflowProblem ? error.message : (error as Error).name,
        );
      res.status(status).json({
        success: false,
        message:
          status >= 500
            ? 'Payment processing unavailable; retry delivery'
            : (error as Error).message,
      });
    }
  },
);
router.get(
  '/sepay/receipts',
  protect,
  requireRole(0, 1, 5),
  asyncHandler(async (req, res) => {
    const page = boundedInteger(req.query.page ?? 1, 1, 100000),
      limit = boundedInteger(req.query.limit ?? 20, 1, 50);
    if (!page || !limit) {
      sendResponse(res, 400, false, 'Thông tin phân trang không hợp lệ');
      return;
    }
    const filter = { $or: [{ status: { $in: ['pending', 'review'] } }, { hasConflict: true }] };
    const [rows, total] = await Promise.all([
      SePayReceipt.find(filter)
        .select('-payloadHash -conflicts.payloadHash')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SePayReceipt.countDocuments(filter),
    ]);
    sendResponse(res, 200, true, 'OK', rows, { total, page, limit });
  }),
);
export default router;
