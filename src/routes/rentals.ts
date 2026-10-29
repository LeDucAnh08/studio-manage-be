import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { requireClientPortal } from '../middleware/featureFlags';
import { asyncHandler } from '../middleware/asyncHandler';
import { createRental, listRentals, getRental, actRental } from '../controllers/rentalController';

const router = Router();
router.use(requireClientPortal);
router.use(protect, requireRole(0, 1, 2, 4, 5, 6));
router.get('/', asyncHandler(listRentals));
router.post('/', requireRole(6), asyncHandler(createRental));
router.get('/:id', asyncHandler(getRental));
router.post('/:id/actions', asyncHandler(actRental));
export default router;
