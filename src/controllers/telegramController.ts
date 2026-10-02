import { Request, Response } from 'express';
import crypto from 'crypto';
import User from '../models/User';
import { sendMessage } from '../services/telegramService';
import { sendResponse } from '../utils/response';

/**
 * POST /api/telegram/generate-link-token
 * Tạo token ngắn hạn (15 phút) để user liên kết Telegram.
 * Trả về URL deeplink đến bot.
 */
export const generateLinkToken = async (req: Request, res: Response): Promise<void> => {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 phút

  await User.findByIdAndUpdate(req.user!._id, {
    telegramLinkToken: token,
    telegramLinkTokenExpiry: expiresAt,
  });

  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  sendResponse(res, 200, true, 'OK', {
    token,
    url: `https://t.me/${botUsername}?start=${token}`,
    expiresAt,
  });
};

/**
 * DELETE /api/telegram/unlink
 * Huỷ liên kết Telegram của user hiện tại.
 */
export const unlinkTelegram = async (req: Request, res: Response): Promise<void> => {
  await User.findByIdAndUpdate(req.user!._id, {
    telegramId: null,
    telegramUsername: null,
    telegramLinkToken: null,
    telegramLinkTokenExpiry: null,
  });
  sendResponse(res, 200, true, 'Đã huỷ liên kết Telegram');
};

/**
 * GET /api/telegram/status
 * Kiểm tra trạng thái liên kết Telegram của user hiện tại.
 */
export const getTelegramStatus = async (req: Request, res: Response): Promise<void> => {
  const user = await User.findById(req.user!._id).select('telegramId telegramUsername').lean();
  sendResponse(res, 200, true, 'OK', {
    linked: !!user?.telegramId,
    telegramUsername: user?.telegramUsername ?? null,
  });
};

/**
 * POST /api/telegram/webhook
 * Nhận cập nhật từ Telegram (do Telegram gọi, không phải frontend).
 * Xác thực bằng header X-Telegram-Bot-Api-Secret-Token.
 */
export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secretToken !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    sendResponse(res, 403, false, 'Forbidden');
    return;
  }

  // Luôn trả 200 sớm để Telegram không retry
  res.sendStatus(200);

  const update = req.body as TelegramUpdate;
  const message = update?.message;
  if (!message?.text) return;

  const telegramId = String(message.from.id);
  const telegramUsername = message.from.username ?? null;

  // Chỉ xử lý lệnh /start <token>
  if (!message.text.startsWith('/start')) return;

  const parts = message.text.trim().split(' ');
  const linkToken = parts[1];

  if (!linkToken) {
    await sendMessage(
      telegramId,
      'Chào bạn! Vui lòng mở ứng dụng quản lý studio và bấm <b>"Liên kết Telegram"</b> để bắt đầu.',
    );
    return;
  }

  // Tìm user theo token và kiểm tra hết hạn
  const user = await User.findOne({
    telegramLinkToken: linkToken,
    telegramLinkTokenExpiry: { $gt: new Date() },
  }).select('+telegramLinkToken +telegramLinkTokenExpiry name username');

  if (!user) {
    await sendMessage(
      telegramId,
      '❌ Liên kết không hợp lệ hoặc đã hết hạn (15 phút).\nVui lòng tạo liên kết mới từ ứng dụng.',
    );
    return;
  }

  // Kiểm tra telegramId đã được dùng bởi tài khoản khác chưa
  const conflict = await User.findOne({ telegramId, _id: { $ne: user._id } });
  if (conflict) {
    await sendMessage(
      telegramId,
      '⚠️ Tài khoản Telegram này đã được liên kết với người dùng khác.\nVui lòng liên hệ quản trị viên.',
    );
    return;
  }

  await User.findByIdAndUpdate(user._id, {
    telegramId,
    telegramUsername,
    telegramLinkToken: null,
    telegramLinkTokenExpiry: null,
  });

  await sendMessage(
    telegramId,
    `✅ Liên kết thành công!\nXin chào <b>${user.name ?? user.username}</b> 👋\n\nBạn sẽ nhận thông báo tại đây khi có:\n• 📅 Lịch chụp mới được phân công\n• 💰 Giao dịch mới được tạo`,
  );
};

// ── Types ──────────────────────────────────────────────────────────────────

interface TelegramUpdate {
  message?: {
    text?: string;
    from: { id: number; username?: string };
  };
}
