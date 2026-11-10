import { createHash, randomBytes } from 'node:crypto';
import { ClientSession, isValidObjectId } from 'mongoose';
import Booking from '../models/Booking';
import Workflow from '../models/BookingWorkflow';
import Album from '../models/BookingAlbum';
import Photo from '../models/BookingAlbumPhoto';
import { deliveryAccess } from './bookingDelivery';
import { DriveImage, driveMetadata, readDriveImage } from './driveAlbumSource';
import { withResourceTransaction, workflowEnabled, WorkflowProblem } from './workflowTransactions';

export const albumHash = (token: string) => createHash('sha256').update(token).digest('hex');
type Actor = { _id: unknown; roles: number[] };
export async function staffAlbumAccess(id: string, actor: Actor, session?: ClientSession) {
  const access = await deliveryAccess(id, actor, session);
  if (!access.staff) throw new WorkflowProblem(404, 'Không tìm thấy album.');
  if (access.booking.status !== 'approved' || access.workflow.lifecycle === 'cancelled')
    throw new WorkflowProblem(409, 'Đơn hiện không cho phép quản lý album.');
  return access;
}
export async function publicAlbumAccess(publicId: string, token: string, session?: ClientSession) {
  if (!/^[\w-]{24,64}$/.test(publicId) || !/^[\w-]{43}$/.test(token))
    throw new WorkflowProblem(404, 'Link album không còn khả dụng.');
  const album = await Album.findOne({
    publicId,
    shared: true,
    tokenHash: albumHash(token),
    status: { $ne: 'draft' },
  }).session(session || null);
  if (!album) throw new WorkflowProblem(404, 'Link album không còn khả dụng.');
  const booking = await Booking.findById(album.booking).session(session || null);
  const workflow = await Workflow.findOne({ booking: album.booking }).session(session || null);
  if (!booking || booking.status !== 'approved' || !workflow || workflow.lifecycle === 'cancelled')
    throw new WorkflowProblem(404, 'Link album không còn khả dụng.');
  return { album, booking, workflow };
}
export async function ownerAlbumAccess(id: string, actor: Actor, session?: ClientSession) {
  const access = await deliveryAccess(id, actor, session);
  if (
    !actor.roles.includes(6) ||
    String(access.booking.client) !== String(actor._id) ||
    access.booking.status !== 'approved' ||
    access.workflow.lifecycle === 'cancelled'
  )
    throw new WorkflowProblem(404, 'Không tìm thấy album.');
  const album = await Album.findOne({ booking: id, status: { $ne: 'draft' } }).session(
    session || null,
  );
  if (!album) throw new WorkflowProblem(404, 'Album chưa được studio xuất bản.');
  return { ...access, album };
}
export const albumPhotoDto = (p: any) => ({
  id: String(p._id),
  source: 'drive' as const,
  name: p.drive.name,
  driveId: p.drive.id,
  sourceVersion: p.drive.checksum || p.drive.version,
  width: p.drive.width,
  height: p.drive.height,
  folderId: p.drive.folderId,
  deliveryVersion: p.deliveryVersion,
  available: p.available,
  selected: p.selected,
  note: p.note,
});
export const driveDeliveryDto = (p: any) => ({ ...albumPhotoDto(p), id: `drive-${p._id}` });
export async function albumDto(album: any, staff = false) {
  const workflow = await Workflow.findOne({ booking: album.booking });
  const versions = (workflow?.deliveryHistory || [])
    .filter((v: any) => v.drivePhotos?.length)
    .map((v: any) => v.version);
  const photos = await Photo.find({
    album: album._id,
    deliveryVersion: { $in: [0, ...versions, ...(staff ? [-1] : [])] },
  })
    .sort({ deliveryVersion: 1, order: 1 })
    .lean();
  return {
    publicId: album.publicId,
    title: album.title,
    version: album.version,
    status: album.status,
    limit: album.limit,
    coverId: album.coverId,
    folders: album.folders.map((f: any) => ({
      id: f.id,
      name: f.name,
      ...(staff
        ? {
            url: `https://drive.google.com/drive/folders/${f.id}${f.resourceKey ? `?resourcekey=${f.resourceKey}` : ''}`,
          }
        : {}),
    })),
    finalizedAt: album.finalizedAt,
    latestDeliveryVersion: workflow?.progress.deliveryVersion || 0,
    canCommentDelivery: workflow?.lifecycle === 'delivered',
    canSelect: album.status === 'open' && workflow?.lifecycle === 'editing',
    deliveryVersions: versions,
    photos: photos.map(albumPhotoDto),
    ...(staff
      ? {
          shared: album.shared,
          skipped: album.skipped,
          workflowVersion: workflow?.version,
          lifecycle: workflow?.lifecycle,
          selectionHistory: album.selectionHistory,
        }
      : {}),
  };
}
// Shared resource transaction also serializes album commands with cancellation/reassignment.
export async function mutateAlbum(
  input: {
    bookingId?: string;
    actor?: Actor;
    customer?: Actor;
    publicId?: string;
    token?: string;
    expectedVersion: unknown;
    key: string;
    operation: string;
    payload: unknown;
  },
  work: (album: any, workflow: any, session: ClientSession) => Promise<void>,
) {
  if (!workflowEnabled()) throw new WorkflowProblem(503, 'Chưa bật xử lý giao dịch.');
  if (!/^[\w.:-]{8,128}$/.test(input.key))
    throw new WorkflowProblem(400, 'Thiếu mã gửi yêu cầu hợp lệ.');
  return withResourceTransaction(async (session) => {
    let album: any, workflow: any;
    if (input.customer && input.bookingId) {
      const access = await ownerAlbumAccess(input.bookingId, input.customer, session);
      workflow = access.workflow;
      album = await Album.findById(access.album._id).select('+requests').session(session);
    } else if (input.actor && input.bookingId) {
      workflow = (await staffAlbumAccess(input.bookingId, input.actor, session)).workflow;
      album = await Album.findOne({ booking: input.bookingId })
        .select('+requests')
        .session(session);
      if (!album && input.operation === 'configure')
        album = new Album({
          booking: input.bookingId,
          title: 'Album',
          publicId: randomBytes(18).toString('base64url'),
        });
    } else {
      const access = await publicAlbumAccess(input.publicId!, input.token!, session);
      workflow = access.workflow;
      album = await Album.findById(access.album._id).select('+requests').session(session);
    }
    if (!album) throw new WorkflowProblem(404, 'Chưa tạo album.');
    const scopedKey = `${input.actor?._id || input.customer?._id || albumHash(input.token!)}:${input.key}`;
    const fingerprint = albumHash(JSON.stringify([input.operation, input.payload]));
    const previous = album.requests.find((r: any) => r.key === scopedKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new WorkflowProblem(409, 'Mã gửi yêu cầu đã dùng cho nội dung khác.');
      return album;
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== album.version)
      throw new WorkflowProblem(
        409,
        'Album đã thay đổi. Tải lại trước khi lưu; nội dung đang viết được giữ nguyên.',
      );
    await work(album, workflow, session);
    album.version++;
    album.requests.push({ key: scopedKey, fingerprint });
    if (album.requests.length > 2000) album.requests = album.requests.slice(-2000);
    await album.save({ session });
    return album;
  });
}
export async function syncAlbumPhotos(
  album: any,
  images: DriveImage[],
  deliveryVersion: number,
  session: ClientSession,
) {
  if (deliveryVersion === 0 && album.status === 'closed')
    throw new WorkflowProblem(409, 'Mở lại lựa chọn trước khi cập nhật ảnh.');
  await Photo.updateMany(
    { album: album._id, deliveryVersion },
    { $set: { available: false } },
    { session },
  );
  // Keep interactions by Drive ID, including when a file disappears and later returns.
  if (images.length)
    await Photo.bulkWrite(
      images.map((drive, order) => ({
        updateOne: {
          filter: { album: album._id, deliveryVersion, 'drive.id': drive.id },
          update: {
            $set: { drive, order, available: true },
            $setOnInsert: { album: album._id, deliveryVersion, selected: false, note: '' },
          },
          upsert: true,
        },
      })),
      { session },
    );
}
export async function publishDriveDelivery(
  bookingId: unknown,
  albumVersion: unknown,
  version: number,
  session: ClientSession,
) {
  const album = await Album.findOne({ booking: bookingId }).session(session);
  if (!album || album.status === 'draft' || album.version !== albumVersion)
    throw new WorkflowProblem(
      409,
      'Album thay đổi hoặc chưa xuất bản. Tải lại trước khi giao ảnh.',
    );
  const draft = await Photo.find({ album: album._id, deliveryVersion: -1, available: true })
    .sort({ order: 1 })
    .session(session);
  if (!draft.length || draft.length > 500)
    throw new WorkflowProblem(400, 'Chọn thư mục có từ 1 đến 500 ảnh đã chỉnh trước khi bàn giao.');
  const created = await Photo.insertMany(
    draft.map((p) => ({
      album: album._id,
      deliveryVersion: version,
      drive: p.drive,
      order: p.order,
    })),
    { session },
  );
  album.version++;
  await album.save({ session });
  return created.map((p) => p._id);
}
export async function preflightDriveDelivery(
  bookingId: string,
  actor: Actor,
  expectedVersion: unknown,
  idempotencyKey: string,
) {
  const { workflow } = await staffAlbumAccess(bookingId, actor);
  // A committed action must remain replayable if Google later becomes unavailable.
  if (workflow.idempotency.some((entry: any) => entry.key === `${actor._id}:${idempotencyKey}`))
    return;
  const album = await Album.findOne({ booking: bookingId });
  if (!album || album.version !== expectedVersion)
    throw new WorkflowProblem(409, 'Album đã thay đổi. Tải lại trước khi giao ảnh.');
  const drafts = await Photo.find({ album: album._id, deliveryVersion: -1, available: true });
  if (!drafts.length || drafts.length > 500)
    throw new WorkflowProblem(400, 'Bản bàn giao cần từ 1 đến 500 ảnh.');
  for (const photo of drafts) {
    const meta = await driveMetadata(photo.drive.id, photo.drive.resourceKey);
    if (
      meta.trashed ||
      meta.capabilities?.canDownload === false ||
      meta.mimeType !== photo.drive.mimeType ||
      (photo.drive.checksum
        ? meta.md5Checksum !== photo.drive.checksum
        : meta.version !== photo.drive.version)
    )
      throw new WorkflowProblem(
        409,
        'Ảnh nguồn đã thay đổi hoặc không tải được. Lấy lại ảnh đã chỉnh trước khi giao.',
      );
  }
}
let activeImages = 0;
export async function readAlbumPhoto(photo: any, thumbnail: boolean) {
  if (!photo.available) throw new WorkflowProblem(409, 'Ảnh nguồn không còn trong thư mục.');
  if (activeImages >= 4)
    throw new WorkflowProblem(429, 'Máy chủ đang tải ảnh. Thử lại sau vài giây.');
  activeImages++;
  try {
    return await readDriveImage(photo.drive as DriveImage, thumbnail);
  } finally {
    activeImages--;
  }
}
export async function bookingDrivePhoto(bookingId: string, photoId: string, actor: Actor) {
  const access = await deliveryAccess(bookingId, actor);
  if (!isValidObjectId(photoId)) throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
  const album = await Album.findOne({ booking: bookingId });
  const photo =
    album && (await Photo.findOne({ _id: photoId, album: album._id, deliveryVersion: { $gt: 0 } }));
  if (
    !photo ||
    !access.workflow.deliveryHistory.some((v: any) =>
      (v.drivePhotos || []).some((id: any) => String(id) === photoId),
    )
  )
    throw new WorkflowProblem(404, 'Không tìm thấy ảnh.');
  return photo;
}
