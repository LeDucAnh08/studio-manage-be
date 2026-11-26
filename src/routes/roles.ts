import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import Role, { ACTIVE_ROLES } from '../models/Role';
import { asyncHandler } from '../middleware/asyncHandler';
import { sendResponse } from '../utils/response';

const router = Router();

// Role metadata is read-only; permissions remain enforced by the existing server rules.
router.get(
  '/',
  protect,
  requireRole(0, 1),
  asyncHandler(async (_req, res) => {
    const roles = await Role.find({ _id: { $in: ACTIVE_ROLES } })
      .select('_id name description')
      .sort({ _id: 1 })
      .lean();
    sendResponse(res, 200, true, 'OK', roles);
  }),
);

export default router;
