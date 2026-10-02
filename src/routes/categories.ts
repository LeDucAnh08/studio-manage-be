import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import * as c from '../controllers/categoryController';

const router = Router();

router.use(protect, requireRole(0, 1));

router.route('/').get(c.getAll).post(c.create);
router.route('/:id').put(c.update).delete(c.remove);

export default router;
