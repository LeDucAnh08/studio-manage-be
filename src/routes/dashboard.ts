import { Router } from 'express';
import { getStats } from '../controllers/dashboardController';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { asyncHandler } from '../middleware/asyncHandler';
import { getPhotographerStats } from '../controllers/photographerDashboardController';

const router = Router();

router.get('/photographer', protect, requireRole(3), asyncHandler(getPhotographerStats));

router.get('/', protect, requireRole(0, 1, 2, 3, 4), getStats);

export default router;
