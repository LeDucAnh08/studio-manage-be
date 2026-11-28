import { createHash, randomUUID } from 'crypto';
import mongoose, { ClientSession, isValidObjectId } from 'mongoose';
import Operation from '../models/BackgroundOperation';
import User from '../models/User';
import BookingAlbum from '../models/BookingAlbum';
import ConceptAlbum from '../models/ConceptAlbum';
import { backgroundJobsEnabled, queueConfig } from '../config/queue';
import { assertJobRuntime } from './jobQueue';
import { WorkflowProblem, workflowEnabled } from './workflowTransactions';
import { staffAlbumAccess } from './bookingAlbum';
import { executeBookingAlbumCommand } from './bookingAlbumCommand';
import { accessOrder, admin, assigned } from './conceptBooking';
import { albumCommand } from './conceptAlbum';
import { commandKey } from './conceptPolicy';
import { listDriveFolders, parseDriveFolder } from './driveAlbumSource';

export type AlbumService = 'yearbook' | 'concept';
export async function shouldQueueAlbumSync() {
  if (!backgroundJobsEnabled()) return false;
  if (process.env.NODE_ENV === 'test') return true;
  const config = queueConfig();
  if (config.mode !== 'bullmq') return false;
  const runtime = await mongoose.connection
    .collection('backgroundjobruntime')
    .findOne({ _id: 'runtime' as any });
  return Boolean(
    runtime?.mode === 'bullmq' &&
      runtime?.prefix === config.prefix &&
      runtime?.workerSeenAt &&
      Date.now() - new Date(runtime.workerSeenAt).getTime() < 30_000,
  );
}
export async function resolvePendingAlbumOperations(service: AlbumService, id: string) {
  if (!isValidObjectId(id)) return;
  await Operation.updateMany(
    { service, order: id, status: { $in: ['pending', 'running'] } },
    {
      $set: {
        status: 'succeeded',
        active: false,
        message: 'Đã đồng bộ ảnh.',
        completedAt: new Date(),
      },
      $unset: { leaseToken: 1, lockedUntil: 1 },
    },
  );
}
export const operationDto = (row: any) => ({
  id: String(row._id),
  service: row.service,
  orderId: String(row.order),
  status: row.status,
  message: row.message || '',
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
});

export async function albumOperationAccess(
  service: string,
  id: string,
  actor: any,
  session?: ClientSession,
) {
  if (
    !isValidObjectId(id) ||
    !['yearbook', 'concept'].includes(service) ||
    !actor?.roles?.some((r: number) => [0, 1, 3].includes(r))
  )
    throw new WorkflowProblem(404, 'Không tìm thấy tác vụ đồng bộ.');
  if (service === 'yearbook') {
    if (!workflowEnabled()) throw new WorkflowProblem(404, 'Chức năng chưa được bật.');
    await staffAlbumAccess(id, actor, session);
  } else {
    const order = await accessOrder(id, actor, session);
    if (!admin(actor) && !assigned(order, actor))
      throw new WorkflowProblem(404, 'Không tìm thấy tác vụ đồng bộ.');
    if (!['shot', 'completed'].includes(order.status))
      throw new WorkflowProblem(409, 'Buổi chụp chưa hoàn tất.');
  }
}

export async function submitAlbumOperation(
  service: AlbumService,
  id: string,
  actor: any,
  command: string,
  input: any,
  key: string,
) {
  await albumOperationAccess(service, id, actor);
  commandKey(key);
  const config = queueConfig();
  if (config.mode !== 'bullmq') throw new WorkflowProblem(409, 'Xử lý nền chưa được bật.');
  if (
    !['configure', 'sync', 'delivery-sync'].includes(command) ||
    (service === 'concept' && command !== 'sync')
  )
    throw new WorkflowProblem(400, 'Thao tác đồng bộ không hợp lệ.');
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    Object.keys(input).some((k) => !['expectedVersion', 'title', 'limit', 'folders'].includes(k))
  )
    throw new WorkflowProblem(400, 'Kiểm tra thông tin và phiên bản album.');
  const payload: Record<string, any> = { expectedVersion: input.expectedVersion };
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 160)
      throw new WorkflowProblem(400, 'Tên album cần từ 1 đến 160 ký tự.');
    payload.title = input.title.trim();
  }
  if (command === 'configure') {
    if (!payload.title || !Number.isInteger(input.limit) || input.limit < 0 || input.limit > 10000)
      throw new WorkflowProblem(400, 'Kiểm tra tên album và giới hạn chọn (0 là không giới hạn).');
    payload.limit = input.limit;
  }
  if (service === 'concept' || command !== 'sync') {
    if (!Array.isArray(input.folders) || !input.folders.length || input.folders.length > 10)
      throw new WorkflowProblem(400, 'Thêm từ 1 đến 10 thư mục.');
    const parsed = input.folders.map(parseDriveFolder);
    if (new Set(parsed.map((f: any) => f.id)).size !== parsed.length)
      throw new WorkflowProblem(400, 'Thư mục bị trùng.');
    payload.folders = input.folders.map((f: string) => f.trim());
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([service, id, command, payload]))
    .digest('hex');
  const previous = await Operation.findOne({ actor: actor._id, key }).select('+fingerprint');
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new WorkflowProblem(409, 'Mã gửi đã dùng cho nội dung khác.');
    return previous;
  }
  const album =
    service === 'yearbook'
      ? await BookingAlbum.findOne({ booking: id })
      : await ConceptAlbum.findOne({ order: id });
  if ((album?.version || 0) !== input.expectedVersion)
    throw new WorkflowProblem(409, 'Album đã thay đổi. Tải lại trước khi đồng bộ.');
  try {
    return await Operation.create({
      service,
      order: id,
      actor: actor._id,
      command,
      payload,
      key,
      fingerprint,
      namespace: config.prefix,
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const row = await Operation.findOne({ actor: actor._id, key }).select('+fingerprint');
    if (row?.fingerprint === fingerprint) return row;
    throw new WorkflowProblem(409, 'Album đang có yêu cầu đồng bộ khác. Vui lòng chờ hoàn tất.');
  }
}

export async function executeAlbumOperation(id: string) {
  await assertJobRuntime();
  const config = queueConfig();
  if (config.mode !== 'bullmq') return 'idle';
  const now = new Date(),
    leaseToken = randomUUID();
  const row: any = await Operation.findOneAndUpdate(
    {
      _id: id,
      namespace: config.prefix,
      $or: [
        { status: 'pending', nextAttemptAt: { $lte: now } },
        { status: 'running', lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: 'running', leaseToken, lockedUntil: new Date(+now + 120000) },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).select('+payload +key +leaseToken');
  if (!row) return 'idle';
  const owned = { _id: row._id, status: 'running', leaseToken };
  const timer = setInterval(() => {
    void Operation.updateOne(
      { ...owned, lockedUntil: { $gt: new Date() } },
      { $set: { lockedUntil: new Date(Date.now() + 120000) } },
    ).catch(() => console.error('[Jobs] Album lease renewal unavailable'));
  }, 30000);
  timer.unref();
  try {
    if (row.attempts > 5)
      throw new WorkflowProblem(409, 'Tác vụ đã vượt số lần thử. Vui lòng gửi yêu cầu mới.');
    const actor: any = await User.findOne({ _id: row.actor, isActive: true });
    await albumOperationAccess(row.service, String(row.order), actor);
    let folders = row.payload.folders;
    if (row.command === 'sync' && (!Array.isArray(folders) || !folders.length)) {
      if (row.service === 'yearbook') {
        const album = await BookingAlbum.findOne({ booking: row.order });
        folders = album?.folders.map(
          (f) =>
            `https://drive.google.com/drive/folders/${f.id}${f.resourceKey ? `?resourcekey=${f.resourceKey}` : ''}`,
        );
      } else {
        const album = await ConceptAlbum.findOne({ order: row.order });
        folders = album?.folders;
      }
    }
    const source = await listDriveFolders(folders);
    const guard = async (session: ClientSession) => {
      await assertJobRuntime();
      const current = await User.findOne({ _id: row.actor, isActive: true }).session(session);
      await albumOperationAccess(row.service, String(row.order), current, session);
      // The album snapshot and successful operation state commit together. A crash
      // after commit cannot leave completed work pending for an unsafe replay.
      const held = await Operation.updateOne(
        { ...owned, lockedUntil: { $gt: new Date() } },
        {
          $set: {
            status: 'succeeded',
            active: false,
            message: 'Đã đồng bộ ảnh.',
            completedAt: new Date(),
          },
          $unset: { leaseToken: 1, lockedUntil: 1 },
        },
        { session },
      );
      if (!held.matchedCount)
        throw new WorkflowProblem(409, 'Tác vụ đã được tiến trình khác tiếp nhận.');
    };
    if (row.service === 'yearbook')
      await executeBookingAlbumCommand(
        String(row.order),
        actor,
        row.command,
        row.payload,
        row.key,
        source,
        guard,
      );
    else await albumCommand(String(row.order), actor, 'sync', row.payload, row.key, source, guard);
    await Operation.updateOne(owned, {
      $set: {
        status: 'succeeded',
        active: false,
        message: 'Đã đồng bộ ảnh.',
        completedAt: new Date(),
      },
      $unset: { leaseToken: 1, lockedUntil: 1 },
    });
    return 'handled';
  } catch (error) {
    const code = (error as WorkflowProblem).status;
    const terminal = (code && code < 500 && ![408, 429].includes(code)) || row.attempts >= 5;
    await Operation.updateOne(owned, {
      $set: {
        status: terminal ? 'failed' : 'pending',
        active: !terminal,
        message:
          code && code < 500
            ? (error as Error).message
            : 'Chưa thể đồng bộ ảnh. Danh sách hiện tại được giữ nguyên.',
        nextAttemptAt: new Date(Date.now() + 10000 * 2 ** Math.min(row.attempts - 1, 4)),
        ...(terminal ? { completedAt: new Date() } : {}),
      },
      $unset: { leaseToken: 1, lockedUntil: 1 },
    });
    if (!terminal) throw new Error('Album sync will retry');
    return 'handled';
  } finally {
    clearInterval(timer);
  }
}
