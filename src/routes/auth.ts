import { Router } from 'express';
import { body } from 'express-validator';
import {
  login,
  getMe,
  refresh,
  changePassword,
  updateProfile,
} from '../controllers/authController';
import { protect } from '../middleware/auth';
import { registerClient } from '../controllers/authController';
import { asyncHandler } from '../middleware/asyncHandler';
import { authRateLimit } from '../middleware/authRateLimit';
import { requireClientPortal } from '../middleware/featureFlags';

const router = Router();
router.post('/register', requireClientPortal, authRateLimit, asyncHandler(registerClient));

router.post(
  '/login',
  authRateLimit,
  [
    body('username').isString().trim().notEmpty().withMessage('Username is required'),
    body('password').isString().notEmpty().withMessage('Password is required'),
  ],
  asyncHandler(login),
);

router.get('/me', protect, getMe);
router.post('/refresh', protect, refresh);
router.patch('/change-password', protect, asyncHandler(changePassword));
router.patch('/profile', protect, asyncHandler(updateProfile));

export default router;
