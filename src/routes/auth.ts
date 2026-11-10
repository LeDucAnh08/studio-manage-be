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
import { requestEmailVerification, confirmEmailVerification } from '../controllers/emailController';
import { createRateLimit } from '../middleware/authRateLimit';

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
const emailRateLimit = createRateLimit({
  limit: 10,
  windowMs: 60 * 60 * 1000,
  message: 'Bạn đã gửi quá nhiều yêu cầu email. Vui lòng thử lại sau.',
});
router.post(
  '/email/request',
  requireClientPortal,
  protect,
  emailRateLimit,
  asyncHandler(requestEmailVerification),
);
router.post(
  '/email/confirm',
  requireClientPortal,
  protect,
  authRateLimit,
  asyncHandler(confirmEmailVerification),
);

export default router;
