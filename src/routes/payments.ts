import { Router, raw, json } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticateSePay, ingestSePayPayload } from '../services/sepay';
import { WorkflowProblem } from '../services/workflowTransactions';
import SePayReceipt from '../models/SePayReceipt';
import { boundedInteger } from '../utils/input';
import { sendResponse } from '../utils/response';
import { isValidObjectId } from 'mongoose';
import { sepayConfig, sandboxUiEnabled } from '../services/depositPayment';
import { withResourceTransaction } from '../services/workflowTransactions';
import { applyRentalReceipt } from '../services/rentalCheckout';
import { simulateSandboxDeposit } from '../services/sepaySandbox';

const router = Router();
router.post(
  '/sepay/sandbox/simulate',
  (_req, res, next) => {
    if (!sandboxUiEnabled()) {
      sendResponse(res, 404, false, 'Không có chức năng này.');
      return;
    }
    next();
  },
  protect,
  requireRole(0, 1, 5, 6),
  json({ limit: '2kb' }),
  asyncHandler(async (req, res) => {
    try {
      const result = await simulateSandboxDeposit(
        req.user!,
        req.body?.reference,
        req.get('Idempotency-Key'),
      );
      sendResponse(res, 200, true, 'Đã tạo giao dịch thử; không chuyển tiền thật.', result);
    } catch (error) {
      if (!(error instanceof WorkflowProblem)) throw error;
      sendResponse(res, error.status, false, error.message);
    }
  }),
);
router.post(
  '/sepay/receipts/:id/resolve-rental',
  protect,
  requireRole(0, 1, 5),
  json({ limit: '4kb' }),
  asyncHandler(async (req, res) => {
    try {
      const { rentalId, note } = req.body || {};
      if (
        !isValidObjectId(req.params.id) ||
        !isValidObjectId(rentalId) ||
        typeof note !== 'string' ||
        !note.trim() ||
        note.length > 1000
      )
        throw new WorkflowProblem(400, 'Cần mã đơn thuê và ghi chú đối soát hợp lệ.');
      await withResourceTransaction(async (session) => {
        const receipt = await SePayReceipt.findById(req.params.id).session(session);
        if (
          !receipt ||
          receipt.direction !== 'in' ||
          receipt.hasConflict ||
          receipt.booking ||
          receipt.conceptOrder
        )
          throw new WorkflowProblem(409, 'Giao dịch không đủ điều kiện đối soát đơn thuê.');
        if (receipt.status === 'applied') {
          if (String(receipt.rentalOrder) !== rentalId)
            throw new WorkflowProblem(409, 'Giao dịch đã được ghi nhận cho đơn khác.');
          return;
        }
        if (receipt.status !== 'review')
          throw new WorkflowProblem(409, 'Giao dịch chưa ở trạng thái cần đối soát.');
        if (receipt.rentalOrder && String(receipt.rentalOrder) !== rentalId)
          throw new WorkflowProblem(
            409,
            'Không được chuyển tiền đã khớp mã đơn thuê sang đơn khác.',
          );
        await applyRentalReceipt(receipt, session, sepayConfig(), rentalId);
        if (String(receipt.status) !== 'applied')
          throw new WorkflowProblem(409, receipt.reason || 'Chưa thể đối soát giao dịch.');
        receipt.resolvedBy = req.user!._id;
        receipt.resolutionNote = note.trim();
        receipt.resolvedAt = new Date();
        await receipt.save({ session });
      });
      sendResponse(res, 200, true, 'Đã đối soát giao dịch vào đơn thuê.');
    } catch (error) {
      if (!(error instanceof WorkflowProblem)) throw error;
      sendResponse(res, error.status, false, error.message);
    }
  }),
);
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
