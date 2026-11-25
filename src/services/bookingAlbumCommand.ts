import { createHmac } from 'crypto';
import { ClientSession } from 'mongoose';
import Album from '../models/BookingAlbum';
import Photo from '../models/BookingAlbumPhoto';
import { listDriveFolders } from './driveAlbumSource';
import {
  albumDto,
  albumHash,
  mutateAlbum,
  staffAlbumAccess,
  syncAlbumPhotos,
} from './bookingAlbum';
import { WorkflowProblem } from './workflowTransactions';
export type DriveSource = Awaited<ReturnType<typeof listDriveFolders>>;
export async function executeBookingAlbumCommand(
  id: string,
  actor: any,
  operation: string,
  body: any,
  key: string,
  suppliedSource?: DriveSource,
  beforeCommit?: (session: ClientSession) => Promise<void>,
) {
  await staffAlbumAccess(id, actor);
  let source = suppliedSource;
  if (!source && ['configure', 'sync', 'delivery-sync'].includes(operation)) {
    const album = await Album.findOne({ booking: id });
    const folders =
      operation === 'sync'
        ? album?.folders.map(
            (f) =>
              `https://drive.google.com/drive/folders/${f.id}${f.resourceKey ? `?resourcekey=${f.resourceKey}` : ''}`,
          )
        : body.folders;
    source = await listDriveFolders(folders);
  }
  if (operation === 'share' && !process.env.JWT_SECRET)
    throw new WorkflowProblem(503, 'Chưa cấu hình bí mật xác thực.');
  const token =
    operation === 'share'
      ? createHmac('sha256', process.env.JWT_SECRET!)
          .update(JSON.stringify(['album-share', id, String(actor._id), key]))
          .digest('base64url')
      : undefined;
  const album = await mutateAlbum(
    {
      bookingId: id,
      actor: actor,
      expectedVersion: body.expectedVersion,
      key: key,
      operation,
      payload: body,
    },
    async (a, workflow, session) => {
      await beforeCommit?.(session);
      if (
        ['configure', 'sync', 'publish', 'reopen'].includes(operation) &&
        workflow.lifecycle !== 'editing'
      )
        throw new WorkflowProblem(409, 'Chỉ mở/cập nhật lựa chọn khi đơn đang hậu kỳ.');
      if (operation === 'configure') {
        if (
          typeof body.title !== 'string' ||
          !body.title.trim() ||
          body.title.trim().length > 160 ||
          !Number.isInteger(body.limit) ||
          body.limit < 0 ||
          body.limit > 10000
        )
          throw new WorkflowProblem(
            400,
            'Kiểm tra tên album và giới hạn chọn (0 là không giới hạn).',
          );
        if (a.status === 'closed')
          throw new WorkflowProblem(409, 'Mở lại lựa chọn trước khi sửa album.');
        const selected = await Photo.countDocuments({
          album: a._id,
          deliveryVersion: 0,
          selected: true,
          available: true,
        }).session(session);
        if (body.limit && body.limit < selected)
          throw new WorkflowProblem(409, 'Giới hạn mới nhỏ hơn số ảnh đã chọn.');
        a.title = body.title.trim();
        a.limit = body.limit;
      }
      if (source) {
        if (
          operation === 'delivery-sync' &&
          !['editing', 'revision_requested'].includes(workflow.lifecycle)
        )
          throw new WorkflowProblem(
            409,
            'Chỉ chuẩn bị ảnh bàn giao khi đang hậu kỳ/cần chỉnh sửa.',
          );
        await syncAlbumPhotos(a, source.images, operation === 'delivery-sync' ? -1 : 0, session);
        if (
          operation !== 'delivery-sync' &&
          a.limit &&
          (await Photo.countDocuments({
            album: a._id,
            deliveryVersion: 0,
            available: true,
            selected: true,
          }).session(session)) > a.limit
        )
          throw new WorkflowProblem(
            409,
            'Ảnh trở lại thư mục khiến lựa chọn vượt giới hạn. Tăng giới hạn trước khi đồng bộ.',
          );
        a.skipped = source.skipped;
        if (operation !== 'delivery-sync') {
          a.folders = source.folders;
          if (!source.images.some((p) => p.id === a.coverId)) a.coverId = source.images[0]?.id;
        }
      }
      if (operation === 'publish' || operation === 'reopen') {
        if (
          !(await Photo.exists({ album: a._id, deliveryVersion: 0, available: true }).session(
            session,
          ))
        )
          throw new WorkflowProblem(400, 'Album cần có ảnh trước khi mở chọn.');
        a.status = 'open';
        a.finalizedAt = undefined;
      }
      if (operation === 'close') {
        if (a.status !== 'open') throw new WorkflowProblem(409, 'Album chưa mở chọn.');
        a.status = 'closed';
      }
      if (operation === 'share') {
        a.tokenHash = albumHash(token!);
        a.shared = true;
      }
      if (operation === 'revoke') {
        a.shared = false;
        a.tokenHash = undefined;
      }
      if (operation === 'cover') {
        if (typeof body.coverId !== 'string' || !/^[\w-]{10,200}$/.test(body.coverId))
          throw new WorkflowProblem(400, 'Ảnh bìa không hợp lệ.');
        if (
          !(await Photo.exists({
            album: a._id,
            deliveryVersion: 0,
            available: true,
            'drive.id': body.coverId,
          }).session(session))
        )
          throw new WorkflowProblem(400, 'Chọn ảnh bìa thuộc album.');
        a.coverId = body.coverId;
      }
    },
  );
  // Replaying share cannot return a different secret for the existing token hash.
  const actual = await Album.findById(album._id).select('+tokenHash');
  return {
    ...(await albumDto(album, true)),
    ...(token && actual?.tokenHash === albumHash(token) ? { token } : {}),
  };
}
