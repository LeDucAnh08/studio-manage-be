import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import * as c from '../controllers/scheduleController';

const router = Router();

router.use(protect);

router.get('/', requireRole(0, 1, 2, 3, 4), c.getAll);
router.post('/', requireRole(0, 1, 2, 4), c.create);
router.get('/customer/:customer', requireRole(0, 1, 2, 3, 4), c.getByCustomer);
router.get('/:id/contract', requireRole(0, 1, 2, 4), c.exportContract);
router.get('/:id', requireRole(0, 1, 2, 3, 4), c.getOne);
router.put('/:id', requireRole(0, 1, 2, 4), c.update);
router.delete('/:id', requireRole(0, 1, 2, 4), c.remove);

export default router;
