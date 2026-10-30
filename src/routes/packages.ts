import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import * as packageController from '../controllers/packageController';
import {
  validatePackageId,
  receivePackageContent,
  updatePackageContent,
} from '../controllers/packageContentController';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();
router.use(protect);

router.get('/', requireRole(0, 1, 2, 4), asyncHandler(packageController.getAll));
router.get(
  '/:id',
  requireRole(0, 1, 2, 4),
  validatePackageId,
  asyncHandler(packageController.getOne),
);
router.use(requireRole(0, 1));

router.put(
  '/:id/content',
  validatePackageId,
  receivePackageContent,
  asyncHandler(updatePackageContent),
);

router.post('/', asyncHandler(packageController.create));
router.put('/:id', validatePackageId, asyncHandler(packageController.update));
router.delete('/:id', validatePackageId, asyncHandler(packageController.remove));

export default router;
