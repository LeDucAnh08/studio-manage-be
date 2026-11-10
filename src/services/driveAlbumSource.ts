import { WorkflowProblem } from './workflowTransactions';
import { createHash } from 'node:crypto';

export interface DriveFolder {
  id: string;
  resourceKey?: string;
  name?: string;
}
export interface DriveImage {
  id: string;
  resourceKey?: string;
  name: string;
  mimeType: string;
  version: string;
  checksum?: string;
  size: number;
  width: number;
  height: number;
  folderId: string;
}
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const validId = (value: string) => /^[\w-]{10,200}$/.test(value);
export function parseDriveFolder(input: unknown): DriveFolder {
  if (typeof input !== 'string') throw new WorkflowProblem(400, 'Nhập link thư mục Google Drive.');
  try {
    const url = new URL(input.trim());
    const id = url.pathname.match(/\/folders\/([\w-]+)/)?.[1];
    const resourceKey = url.searchParams.get('resourcekey') || undefined;
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'drive.google.com' ||
      !id ||
      !validId(id) ||
      (resourceKey && !validId(resourceKey))
    )
      throw new Error();
    return { id, ...(resourceKey ? { resourceKey } : {}) };
  } catch {
    throw new WorkflowProblem(400, 'Dùng link https://drive.google.com/drive/folders/... hợp lệ.');
  }
}
function apiUrl(file?: string) {
  const key = process.env.GOOGLE_DRIVE_API_KEY;
  if (!key) throw new WorkflowProblem(503, 'Studio chưa cấu hình GOOGLE_DRIVE_API_KEY.');
  const url = new URL(
    'https://www.googleapis.com/drive/v3/files' + (file ? '/' + encodeURIComponent(file) : ''),
  );
  url.searchParams.set('key', key);
  return url;
}
function driveHeaders(id: string, key?: string): Record<string, string> {
  return key ? { 'X-Goog-Drive-Resource-Keys': `${id}/${key}` } : {};
}
async function fetchDrive(url: URL, headers: Record<string, string> = {}) {
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: { errors?: Array<{ reason?: string }> };
      } | null;
      const busy =
        response.status === 429 ||
        response.status >= 500 ||
        detail?.error?.errors?.some((e) =>
          /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|downloadQuotaExceeded/i.test(
            e.reason || '',
          ),
        );
      throw new WorkflowProblem(
        busy ? 503 : 409,
        busy
          ? 'Google Drive đang bận. Thử lại sau.'
          : 'Không đọc được ảnh/thư mục Drive. Kiểm tra chế độ chia sẻ và nguồn ảnh.',
      );
    }
    return response;
  } catch (error) {
    if (error instanceof WorkflowProblem) throw error;
    throw new WorkflowProblem(503, 'Kết nối Google Drive bị gián đoạn. Thử lại sau.');
  }
}
export async function driveMetadata(id: string, resourceKey?: string) {
  const url = apiUrl(id);
  url.searchParams.set(
    'fields',
    'id,name,mimeType,version,md5Checksum,size,resourceKey,trashed,imageMediaMetadata,capabilities(canDownload)',
  );
  return (await fetchDrive(url, driveHeaders(id, resourceKey))).json() as Promise<{
    id: string;
    name: string;
    mimeType: string;
    version: string;
    md5Checksum?: string;
    size?: string;
    resourceKey?: string;
    trashed?: boolean;
    imageMediaMetadata?: { width?: number; height?: number };
    capabilities?: { canDownload?: boolean };
  }>;
}
export async function listDriveFolders(input: unknown) {
  if (!Array.isArray(input) || !input.length || input.length > 10)
    throw new WorkflowProblem(400, 'Thêm từ 1 đến 10 thư mục.');
  const folders = input.map(parseDriveFolder);
  if (new Set(folders.map((x) => x.id)).size !== folders.length)
    throw new WorkflowProblem(400, 'Thư mục bị trùng.');
  const images: DriveImage[] = [],
    skipped: string[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const meta = await driveMetadata(folder.id, folder.resourceKey);
    if (meta.trashed || meta.mimeType !== 'application/vnd.google-apps.folder')
      throw new WorkflowProblem(409, 'Link phải trỏ đến thư mục Drive đang chia sẻ.');
    folder.name = meta.name;
    let nextPageToken: string | undefined;
    const pages = new Set<string>();
    do {
      const url = apiUrl();
      url.searchParams.set('q', `'${folder.id}' in parents and trashed = false`);
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('orderBy', 'name');
      url.searchParams.set(
        'fields',
        'nextPageToken,incompleteSearch,files(id,name,mimeType,version,md5Checksum,size,resourceKey,imageMediaMetadata)',
      );
      if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
      const data = (await (
        await fetchDrive(url, driveHeaders(folder.id, folder.resourceKey))
      ).json()) as {
        files?: Array<Awaited<ReturnType<typeof driveMetadata>>>;
        nextPageToken?: string;
        incompleteSearch?: boolean;
      };
      if (data.incompleteSearch || !Array.isArray(data.files))
        throw new WorkflowProblem(
          503,
          'Drive chưa trả đủ danh sách ảnh. Danh sách cũ được giữ nguyên.',
        );
      for (const file of data.files) {
        if (!imageTypes.includes(file.mimeType)) {
          skipped.push(file.name);
          continue;
        }
        if (!file.version || !validId(file.id))
          throw new WorkflowProblem(503, 'Drive trả thông tin ảnh chưa đầy đủ.');
        if (!seen.has(file.id)) {
          seen.add(file.id);
          images.push({
            id: file.id,
            resourceKey: file.resourceKey,
            name: file.name,
            mimeType: file.mimeType,
            version: file.version,
            checksum: file.md5Checksum,
            size: Number(file.size || 0),
            width: file.imageMediaMetadata?.width || 0,
            height: file.imageMediaMetadata?.height || 0,
            folderId: folder.id,
          });
        }
      }
      if (images.length + skipped.length > 10_000)
        throw new WorkflowProblem(400, 'Album tối đa 10.000 tệp. Chia nhỏ thư mục để tiếp tục.');
      nextPageToken = data.nextPageToken;
      if (nextPageToken && pages.has(nextPageToken))
        throw new WorkflowProblem(503, 'Drive trả trang dữ liệu lặp. Thử lại sau.');
      if (nextPageToken) pages.add(nextPageToken);
    } while (nextPageToken);
  }
  return { folders, images, skipped };
}
// No remote URL is accepted here: only an ID captured by the server's folder sync.
export async function readDriveImage(image: DriveImage, thumbnail: boolean) {
  const meta = await driveMetadata(image.id, image.resourceKey);
  if (
    meta.trashed ||
    meta.mimeType !== image.mimeType ||
    !meta.version ||
    (image.checksum ? meta.md5Checksum !== image.checksum : meta.version !== image.version)
  )
    throw new WorkflowProblem(
      409,
      'Ảnh nguồn đã thay đổi. Studio cần cập nhật hoặc giao phiên bản mới.',
    );
  if (meta.capabilities?.canDownload === false)
    throw new WorkflowProblem(409, 'Drive không cho phép tải ảnh này.');
  const maximum = 40 * 1024 * 1024;
  if (Number(meta.size) > maximum) throw new WorkflowProblem(413, 'Ảnh vượt giới hạn 40 MB.');
  const url = apiUrl(image.id);
  url.searchParams.set('alt', 'media');
  const response = await fetchDrive(url, driveHeaders(image.id, image.resourceKey));
  const reader = response.body?.getReader();
  if (!reader) throw new WorkflowProblem(503, 'Không đọc được nội dung ảnh.');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.length;
      if (size > maximum) throw new WorkflowProblem(413, 'Ảnh vượt giới hạn 40 MB.');
      chunks.push(Buffer.from(value.value));
    }
  } catch (error) {
    if (error instanceof WorkflowProblem) throw error;
    throw new WorkflowProblem(503, 'Tải ảnh Drive bị gián đoạn. Thử lại sau.');
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks);
  if (image.checksum && createHash('md5').update(bytes).digest('hex') !== image.checksum)
    throw new WorkflowProblem(
      409,
      'Ảnh nguồn thay đổi trong lúc tải. Thử lại sau khi studio cập nhật.',
    );
  const sharp = (await import('sharp')).default;
  try {
    const decoded = sharp(bytes, { limitInputPixels: 60_000_000, animated: false });
    const metadata = await decoded.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1)
      throw new Error();
    if (thumbnail)
      return {
        bytes: await decoded
          .rotate()
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer(),
        type: 'image/webp',
      };
    return { bytes, type: image.mimeType };
  } catch {
    throw new WorkflowProblem(409, 'Ảnh Drive không hợp lệ hoặc vượt giới hạn 60 megapixel.');
  }
}
