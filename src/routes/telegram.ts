import { Router } from 'express';
import { protect } from '../middleware/auth';
import { requireRole } from '../middleware/role';
import {
  generateLinkToken,
  unlinkTelegram,
  getTelegramStatus,
  handleWebhook,
} from '../controllers/telegramController';

const router = Router();

// Webhook — Telegram gọi vào đây (không cần JWT)
router.post('/webhook', handleWebhook);
router.use(protect, requireRole(0, 1, 2, 3, 4, 5));

// Các endpoint yêu cầu đăng nhập
router.get('/status', protect, getTelegramStatus);
router.post('/generate-link-token', protect, generateLinkToken);
router.delete('/unlink', protect, unlinkTelegram);

export default router;
