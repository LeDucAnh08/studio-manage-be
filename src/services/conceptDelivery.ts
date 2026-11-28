import { stat } from 'node:fs/promises';
import { ClientSession, isValidObjectId } from 'mongoose';
import ConceptAlbum from '../models/ConceptAlbum';
import ConceptPhoto from '../models/ConceptPhoto';
import Photo from '../models/ConceptDeliveryPhoto';
import { accessOrder, admin, assigned } from './conceptBooking';
import { albumOpen } from './conceptAlbum';
import { deliveryFile } from './bookingDelivery';
import { WorkflowProblem } from './workflowTransactions';

export const conceptDeliveryPhotoDto = (photo: any) => ({
  id: String(photo._id),
  source: 'local' as const,
  name: photo.name,
  width: photo.width,
  height: photo.height,
  available: !photo.deletedAt,
  ...(photo.originalPhotoId && { originalPhotoId: String(photo.originalPhotoId) }),
});

export async function conceptDeliveryAccess(
  orderId: string,
  actor: { _id: unknown; roles: number[] },
  session?: ClientSession,
  write = false,
) {
  if (!isValidObjectId(orderId)) throw new WorkflowProblem(404, 'Không tìm thấy đơn concept.');
  const order = await accessOrder(orderId, actor, session);
  const staff = admin(actor) || assigned(order, actor);
  if (!['shot', 'completed'].includes(order.status)) {
    throw new WorkflowProblem(409, 'Buổi chụp chưa hoàn tất.');
  }
  if (!staff && !albumOpen(order)) {
    throw new WorkflowProblem(404, 'Album chưa mở.');
  }
  if (write && !staff) {
    throw new WorkflowProblem(403, 'Chỉ ekip phụ trách được tải ảnh.');
  }
  return { order, staff };
}

export async function validateConceptReplacementOriginals(
  orderId: unknown,
  originalIds: string[],
  session: ClientSession,
) {
  const album = await ConceptAlbum.findOne({ order: orderId })
    .select('_id status')
    .session(session);
  const count = album
    ? await ConceptPhoto.countDocuments({
        _id: { $in: originalIds },
        album: album._id,
        deliveryVersion: 0,
        available: true,
        selected: true,
      }).session(session)
    : 0;
  if (count !== originalIds.length) {
    throw new WorkflowProblem(409, 'Ảnh gốc hoặc yêu cầu chỉnh sửa đã thay đổi. Tải lại album.');
  }
}

export async function validateConceptDeliveryPhotos(
  input: unknown,
  orderId: unknown,
  session: ClientSession,
) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 500 ||
    input.some((id) => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) ||
    new Set(input).size !== input.length
  ) {
    throw new WorkflowProblem(400, 'Chọn từ 1 đến 500 ảnh hợp lệ, không trùng lặp.');
  }
  const photos = await Photo.find({
    _id: { $in: input },
    order: orderId,
    deletedAt: { $exists: false },
  }).session(session);
  if (photos.length !== input.length) {
    throw new WorkflowProblem(409, 'Có ảnh đã bị xóa hoặc không thuộc đơn này.');
  }
  const originalIds = photos.flatMap((photo) =>
    photo.originalPhotoId ? [String(photo.originalPhotoId)] : [],
  );
  if (new Set(originalIds).size !== originalIds.length) {
    throw new WorkflowProblem(400, 'Mỗi ảnh gốc chỉ nhận một bản chỉnh trong lần bàn giao.');
  }
  if (originalIds.length) {
    await validateConceptReplacementOriginals(orderId, originalIds, session);
  }
  try {
    await Promise.all(
      photos.flatMap((photo) => [
        stat(deliveryFile(String(photo._id))),
        stat(deliveryFile(String(photo._id), true)),
      ]),
    );
  } catch {
    throw new WorkflowProblem(
      409,
      'Có ảnh chưa sẵn sàng. Vui lòng tải lại ảnh trước khi bàn giao.',
    );
  }
  return input;
}
