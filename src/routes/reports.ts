import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { getFinanceReport, getInventoryReport } from '../controllers/reportController';
const router = Router();
router.use(protect, requireRole(0, 1, 5));
router.get('/finance', getFinanceReport);
router.get('/inventory', getInventoryReport);
export default router;
