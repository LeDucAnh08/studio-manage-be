import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import * as controller from '../controllers/accountRequestController';
import { asyncHandler } from '../middleware/asyncHandler';
import { accountRequestRateLimit } from '../middleware/authRateLimit';

const router = Router();
router.post('/', accountRequestRateLimit, asyncHandler(controller.submit));
router.use(protect, requireRole(0, 1));
router.get('/', asyncHandler(controller.getAll));
router.patch('/:id', asyncHandler(controller.review));
export default router;
