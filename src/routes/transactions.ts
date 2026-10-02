import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import * as c from '../controllers/transactionController';

const router = Router();

router.use(protect, requireRole(0, 1, 5));

router.get('/summary', c.getSummary);
router.route('/').get(c.getAll).post(c.create);
router.route('/:id').get(c.getOne).put(c.update).delete(c.remove);

export default router;
