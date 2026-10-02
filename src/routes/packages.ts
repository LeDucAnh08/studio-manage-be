import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import * as packageController from '../controllers/packageController';

const router = Router();
router.use(protect);

router.get('/', requireRole(0, 1, 2, 4), packageController.getAll);
router.get('/:id', requireRole(0, 1, 2, 4), packageController.getOne);
router.use(requireRole(0, 1));

router.post('/', packageController.create);
router.put('/:id', packageController.update);
router.delete('/:id', packageController.remove);

export default router;
