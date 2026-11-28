import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import * as c from '../controllers/scheduleController';

const router = Router();

router.use(protect);

router.get('/mine/calendar', requireRole(3), c.getMyCalendar);
router.get('/photographer/:photographerId/calendar', requireRole(0, 1), c.getPhotographerCalendar);
router.get('/', requireRole(0, 1, 3), c.getAll);
router.post('/', requireRole(0, 1), c.create);
router.get('/customer/:customer', requireRole(0, 1, 3), c.getByCustomer);
router.get('/:id/contract', requireRole(0, 1), c.exportContract);
router.get('/:id', requireRole(0, 1, 3), c.getOne);
router.put('/:id', requireRole(0, 1), c.update);
router.delete('/:id', requireRole(0, 1), c.remove);

export default router;
