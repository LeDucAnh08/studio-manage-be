export interface FolderLogPayload {
  scheduleId: string;
  school: string;
  className: string;
  shootDate: string; // chuỗi đã format dd/mm/yyyy
  startTime?: string;
  location?: string;
  leadPhotographer?: string;
  supportPhotographers?: string[];
  contractUrl?: string;
  status?: string;
}

export interface FolderLogResult {
  folderId: string;
  folderUrl: string;
}

/**
 * Gọi Google Apps Script Web App để tạo folder Drive cho bộ ảnh và ghi 1 dòng
 * vào Google Sheet quản lý nội bộ.
 *
 * Trả về { folderId, folderUrl } nếu thành công, hoặc null nếu chưa cấu hình
 * webhook / gọi thất bại (không throw để không làm gián đoạn luồng tạo lịch).
 */
export async function createFolderAndLog(
  payload: FolderLogPayload,
): Promise<FolderLogResult | null> {
  // Đọc env lúc gọi (không phải lúc load module) để chắc chắn dotenv đã nạp .env
  const GAS_URL = process.env.GAS_WEBHOOK_URL ?? '';
  const GAS_SECRET = process.env.GAS_WEBHOOK_SECRET ?? '';

  if (!GAS_URL) {
    console.warn('[GoogleSheet] GAS_WEBHOOK_URL chưa cấu hình → bỏ qua tạo folder/sheet');
    return null;
  }
  console.log('[GoogleSheet] → gọi webhook', GAS_URL);
  console.log('[GoogleSheet] payload:', JSON.stringify(payload));

  // Timeout 20s để Google bị treo không làm nghẽn request tạo lịch
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: GAS_SECRET, ...payload }),
      redirect: 'follow',
      signal: controller.signal,
    });

    const raw = await res.text();
    console.log(`[GoogleSheet] ← HTTP ${res.status} ${res.headers.get('content-type') ?? ''}`);
    console.log('[GoogleSheet] body (300 ký tự đầu):', raw.slice(0, 300));

    if (!res.ok) {
      console.error(`[GoogleSheet] HTTP lỗi ${res.status}`);
      return null;
    }

    let data: { ok?: boolean; folderId?: string; folderUrl?: string; error?: string };
    try {
      data = JSON.parse(raw);
    } catch {
      console.error(
        '[GoogleSheet] Response KHÔNG phải JSON (thường do web app chưa cấp quyền / sai quyền truy cập). Xem body ở trên.',
      );
      return null;
    }

    if (!data.ok || !data.folderUrl || !data.folderId) {
      console.error('[GoogleSheet] webhook trả về thất bại:', data.error ?? data);
      return null;
    }

    console.log('[GoogleSheet] ✓ tạo folder thành công:', data.folderUrl);
    return { folderId: data.folderId, folderUrl: data.folderUrl };
  } catch (err) {
    console.error('[GoogleSheet] gọi webhook thất bại:', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface DeletePayload {
  scheduleId: string;
  folderId?: string;
}

/**
 * Gọi Apps Script để xoá folder bộ ảnh (vào thùng rác) và dòng tương ứng trong
 * Google Sheet khi xoá lịch chụp. Trả về true nếu webhook báo thành công.
 */
export async function deleteFolderAndRow(payload: DeletePayload): Promise<boolean> {
  const GAS_URL = process.env.GAS_WEBHOOK_URL ?? '';
  const GAS_SECRET = process.env.GAS_WEBHOOK_SECRET ?? '';

  if (!GAS_URL) {
    console.warn('[GoogleSheet] GAS_WEBHOOK_URL chưa cấu hình → bỏ qua xoá folder/sheet');
    return false;
  }
  console.log('[GoogleSheet] → xoá folder/row', JSON.stringify(payload));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: GAS_SECRET, action: 'delete', ...payload }),
      redirect: 'follow',
      signal: controller.signal,
    });
    const raw = await res.text();
    console.log(`[GoogleSheet] ← HTTP ${res.status}`, raw.slice(0, 200));
    if (!res.ok) return false;
    try {
      const data = JSON.parse(raw) as { ok?: boolean };
      return data.ok === true;
    } catch {
      console.error('[GoogleSheet] xoá: response không phải JSON (kiểm tra quyền web app).');
      return false;
    }
  } catch (err) {
    console.error('[GoogleSheet] gọi webhook xoá thất bại:', err);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
