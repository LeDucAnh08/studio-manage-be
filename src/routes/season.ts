import { Router } from 'express';
import * as seasonController from '../controllers/seasonController';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';

const router = Router();

router.get('/', seasonController.getAll);
router.post('/', protect, requireRole(0), seasonController.create);
router.put('/:id', protect, requireRole(0), seasonController.update);
router.delete('/:id', protect, requireRole(0), seasonController.remove);

export default router;
