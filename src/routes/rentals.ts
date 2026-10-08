import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import { requireClientPortal } from '../middleware/featureFlags';
import { asyncHandler } from '../middleware/asyncHandler';
import { createRental, listRentals, getRental, actRental } from '../controllers/rentalController';
import { sendResponse } from '../utils/response';

const router = Router();
router.use(requireClientPortal, (req, res, next) => {
  if (process.env.CLIENT_RENTAL_ENABLED?.toLowerCase() !== 'true') {
    sendResponse(res, 404, false, 'Dịch vụ thuê chưa được mở.');
    return;
  }
  next();
});
router.use(protect, requireRole(0, 1, 2, 4, 5, 6));
router.get('/', asyncHandler(listRentals));
router.post('/', requireRole(6), asyncHandler(createRental));
router.get('/:id', asyncHandler(getRental));
router.post('/:id/actions', asyncHandler(actRental));
export default router;
