import { Router } from 'express';
import { getStats } from '../controllers/dashboardController';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';

const router = Router();

router.get('/', protect, requireRole(0, 1, 2, 3, 4), getStats);

export default router;
