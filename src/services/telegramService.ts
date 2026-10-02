import User from '../models/User';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Gửi tin nhắn trực tiếp đến một chat_id Telegram.
 * Nếu chưa cấu hình BOT_TOKEN thì bỏ qua.
 */
export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    const res = await fetch(`${BASE_URL}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[Telegram] sendMessage error ${res.status}:`, body);
    }
  } catch (err) {
    console.error('[Telegram] sendMessage failed:', err);
  }
}

/**
 * Gửi thông báo đến một user theo userId MongoDB.
 * Bỏ qua nếu user chưa liên kết Telegram.
 */
export async function notifyUser(userId: string, text: string): Promise<void> {
  const user = await User.findById(userId).select('telegramId').lean();
  if (user?.telegramId) {
    await sendMessage(user.telegramId, text);
  }
}

/**
 * Gửi thông báo đến nhiều user theo danh sách userId MongoDB.
 * Chỉ gửi cho những user đã liên kết Telegram.
 */
export async function notifyUsers(userIds: string[], text: string): Promise<void> {
  if (!userIds.length) return;
  const users = await User.find({
    _id: { $in: userIds },
    telegramId: { $ne: null },
  })
    .select('telegramId')
    .lean();
  await Promise.all(
    users.map((u) => (u.telegramId ? sendMessage(u.telegramId, text) : Promise.resolve())),
  );
}

/**
 * Gửi thông báo đến tất cả user có roles chỉ định và đã liên kết Telegram.
 */
export async function notifyByRoles(roles: number[], text: string): Promise<void> {
  const users = await User.find({
    roles: { $in: roles },
    isActive: true,
    telegramId: { $ne: null },
  })
    .select('telegramId')
    .lean();
  await Promise.all(
    users.map((u) => (u.telegramId ? sendMessage(u.telegramId, text) : Promise.resolve())),
  );
}
