import { Router } from 'express';
import { listWorkflows } from '../controllers/workflowController';
import { asyncHandler } from '../middleware/asyncHandler';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { listPhotographerOrders } from '../controllers/photographerOrdersController';
import { listShootOrders } from '../controllers/shootOrdersController';

const router = Router();
router.get('/shoot-orders', protect, requireRole(0, 1, 2, 3, 5), asyncHandler(listShootOrders));

router.get('/photographer-orders', protect, requireRole(3), asyncHandler(listPhotographerOrders));

router.get('/', protect, requireRole(0, 1, 3, 5, 6), asyncHandler(listWorkflows));

export default router;
