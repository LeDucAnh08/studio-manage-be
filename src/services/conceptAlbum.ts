import { createHash, createHmac, randomUUID } from 'crypto';
import { ClientSession } from 'mongoose';
import Album from '../models/ConceptAlbum';
import Photo from '../models/ConceptPhoto';
import Order from '../models/ConceptOrder';
import { readAlbumPhoto } from './bookingAlbum';
import { listDriveFolders } from './driveAlbumSource';
import {
  accessOrder,
  addRequest,
  admin,
  assigned,
  enqueueConceptEmail,
  event,
  owner,
} from './conceptBooking';
import { beginCommand, commandKey, objectId, text } from './conceptPolicy';
import { WorkflowProblem, withResourceTransaction } from './workflowTransactions';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const albumOpen = (order: any) =>
  ['shot', 'completed'].includes(order.status) &&
  order.paymentRequests.some((p: any) => p.kind === 'balance' && p.status === 'paid');
export async function albumAccess(id: string, actor: any, session?: ClientSession) {
  const order = await accessOrder(id, actor, session);
  const staff = admin(actor) || assigned(order, actor);
  if (!staff && !(owner(order, actor) && albumOpen(order)))
    throw new WorkflowProblem(404, 'Album chưa mở.');
  const album = await Album.findOne({ order: id })
    .select('+commands')
    .session(session || null);
  if (!album || (!staff && album.status === 'draft'))
    throw new WorkflowProblem(404, 'Album chưa được xuất bản.');
  return { order, album, staff };
}
export async function guestAccess(publicId: string, token: unknown) {
  if (!/^[\w-]{24,64}$/.test(publicId) || typeof token !== 'string' || !/^[\w-]{43}$/.test(token))
    throw new WorkflowProblem(404, 'Link không hợp lệ.');
  const album = await Album.findOne({
    'share.publicId': publicId,
    'share.tokenHash': hash(token),
    'share.expiresAt': { $gt: new Date() },
    status: { $ne: 'draft' },
  });
  const order = album && (await Order.findById(album.order));
  if (!album || !order || !albumOpen(order))
    throw new WorkflowProblem(404, 'Link đã hết hạn hoặc album chưa mở.');
  return { order, album, staff: false };
}
export async function albumDto(album: any, staff: boolean, guest = false) {
  const photos = await Photo.find({ album: album._id }).sort({ version: 1, order: 1 }).lean();
  return {
    id: String(album._id),
    title: album.title,
    version: album.version,
    status: album.status,
    selectionRound: album.selectionRound,
    deliveryVersion: album.deliveryVersion,
    extraAmount: guest ? undefined : album.extraAmount,
    allowDownload: !guest && album.allowDownload,
    selections: guest ? undefined : album.selections,
    deliveries: album.deliveries.map((d: any) => ({ version: d.version, at: d.at })),
    feedbackRounds: guest ? undefined : album.feedbackRounds,
    paidRequests: guest ? undefined : album.paidRequests,
    freeRoundsUsed: album.feedbackRounds.length,
    ...(staff
      ? {
          folders: album.folders,
          share: { publicId: album.share?.publicId, expiresAt: album.share?.expiresAt },
        }
      : {}),
    photos: photos
      .filter((p) => staff || p.version >= 0)
      .map((p) => ({
        id: String(p._id),
        name: p.drive.name,
        version: p.version,
        width: p.drive.width,
        height: p.drive.height,
        available: p.available,
        ...(guest ? {} : { selected: p.selected, note: p.note }),
      })),
  };
}
const requireStaff = (order: any, actor: any) => {
  if (!(admin(actor) || assigned(order, actor)))
    throw new WorkflowProblem(403, 'Chỉ ekip phụ trách được thao tác.');
};
const requireOwner = (order: any, actor: any) => {
  if (!owner(order, actor)) throw new WorkflowProblem(403, 'Chỉ chủ đơn được thao tác.');
};
export async function albumCommand(id: string, actor: any, operation: string, b: any, key: string) {
  commandKey(key);
  let source: Awaited<ReturnType<typeof listDriveFolders>> | undefined;
  if (['sync', 'deliver'].includes(operation)) {
    const order = await accessOrder(id, actor);
    requireStaff(order, actor);
    source = await listDriveFolders(b.folders);
    if (!source.images.length || source.images.length > 500)
      throw new WorkflowProblem(400, 'Mỗi bộ ảnh cần từ 1 đến 500 ảnh.');
  }
  let shareToken: string | undefined;
  if (operation === 'share') {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16)
      throw new WorkflowProblem(503, 'Chưa cấu hình bí mật server.');
    shareToken = createHmac('sha256', process.env.JWT_SECRET)
      .update(`concept-share:${id}:${actor._id}:${key}`)
      .digest('base64url');
  }
  return withResourceTransaction(async (session) => {
    const order = await accessOrder(id, actor, session);
    if (!['shot', 'completed'].includes(order.status))
      throw new WorkflowProblem(409, 'Buổi chụp chưa hoàn tất.');
    let album = await Album.findOne({ order: id })
      .select('+commands +share.tokenHash')
      .session(session);
    if (!album) {
      requireStaff(order, actor);
      if (operation !== 'sync' || b.expectedVersion !== 0)
        throw new WorkflowProblem(404, 'Đồng bộ ảnh để tạo album.');
      album = new Album({ order: id, title: order.snapshot.name });
    }
    if (!beginCommand(album, key, { actor: String(actor._id), operation, ...b }, b.expectedVersion))
      return {
        album,
        token:
          operation === 'share' && album.share?.tokenHash === hash(shareToken!)
            ? shareToken
            : undefined,
      };
    if (
      [
        'sync',
        'publish',
        'start',
        'deliver',
        'resolve',
        'quote',
        'reopen',
        'share',
        'revoke',
        'download-policy',
      ].includes(operation)
    )
      requireStaff(order, actor);
    else {
      requireOwner(order, actor);
      if (!albumOpen(order))
        throw new WorkflowProblem(403, 'Hoàn tất thanh toán phần còn lại trước khi mở album.');
    }
    if (operation === 'sync') {
      if (!['draft', 'selecting'].includes(album.status))
        throw new WorkflowProblem(409, 'Danh sách đã chốt.');
      album.title = text(b.title || album.title, 160);
      album.folders = b.folders;
      await Photo.updateMany(
        { album: album._id, version: 0 },
        { $set: { available: false } },
        { session },
      );
      for (const [index, image] of source!.images.entries()) {
        const previous = await Photo.findOne({
          album: album._id,
          version: 0,
          'drive.id': image.id,
        }).session(session);
        if (previous) {
          if (
            previous.selected &&
            (previous.drive.checksum || previous.drive.version) !==
              (image.checksum || image.version)
          )
            throw new WorkflowProblem(
              409,
              'Ảnh đang chọn đã đổi nội dung; giữ nguyên nguồn hoặc mở album mới.',
            );
          previous.drive = image;
          previous.available = true;
          previous.order = index;
          await previous.save({ session });
        } else
          await Photo.create([{ album: album._id, version: 0, drive: image, order: index }], {
            session,
          });
      }
    } else if (operation === 'publish') {
      if (!albumOpen(order) || album.status !== 'draft')
        throw new WorkflowProblem(409, 'Cần đủ tiền hợp đồng trước khi mở chọn.');
      album.status = 'selecting';
    } else if (operation === 'photo') {
      if (album.status !== 'selecting') throw new WorkflowProblem(409, 'Danh sách đã khóa.');
      const photo = await Photo.findOne({
        _id: objectId(b.photoId),
        album: album._id,
        version: 0,
      }).session(session);
      if (!photo) throw new WorkflowProblem(404, 'Không có ảnh này.');
      if (!photo.available && b.selected !== false)
        throw new WorkflowProblem(
          409,
          'Ảnh nguồn không còn khả dụng; bỏ chọn hoặc nhờ Studio đồng bộ lại.',
        );
      if (b.selected !== undefined) {
        if (typeof b.selected !== 'boolean')
          throw new WorkflowProblem(400, 'Lựa chọn không hợp lệ.');
        photo.selected = b.selected;
      }
      if (b.note !== undefined) photo.note = text(b.note, 2000, false);
      await photo.save({ session });
    } else if (operation === 'finalize') {
      if (album.status !== 'selecting' || b.accepted !== true)
        throw new WorkflowProblem(409, 'Đồng ý phí phát sinh trước khi chốt.');
      const photos = await Photo.find({ album: album._id, version: 0, selected: true })
        .sort({ order: 1 })
        .session(session);
      if (!photos.length || photos.some((p) => !p.available))
        throw new WorkflowProblem(409, 'Chọn ảnh còn khả dụng trước khi chốt.');
      const extra =
        Math.max(0, photos.length - order.snapshot.retouchQuota) * order.snapshot.extraPhotoPrice;
      album.selectionRound += 1;
      album.selections.push({
        round: album.selectionRound,
        at: new Date(),
        extra,
        photos: photos.map((p) => ({
          photoId: String(p._id),
          driveId: p.drive.id,
          name: p.drive.name,
          note: p.note,
          checksum: p.drive.checksum || p.drive.version,
        })),
      });
      album.extraAmount = extra;
      order.paymentRequests
        .filter((p) => p.kind === 'extra' && p.status === 'pending')
        .forEach((p) => {
          p.status = 'void';
        });
      const alreadyPaid =
        order.payments.filter((p) => p.kind === 'extra').reduce((s, p) => s + (p.amount || 0), 0) -
        order.payments.filter((p) => p.kind === 'refund').reduce((s, p) => s + (p.amount || 0), 0);
      if (extra > alreadyPaid) {
        addRequest(order, 'extra', extra - alreadyPaid, new Date(Date.now() + 7 * 86400000));
        album.status = 'awaiting_extra';
      } else {
        album.status = 'queued';
        order.refundDue = Math.max(0, alreadyPaid - extra);
      }
    } else if (operation === 'reopen') {
      if (
        !admin(actor) ||
        !['queued', 'awaiting_extra'].includes(album.status) ||
        album.deliveryVersion > 0
      )
        throw new WorkflowProblem(409, 'Chỉ admin được mở lại trước khi retouch.');
      album.status = 'selecting';
      order.paymentRequests
        .filter((p) => p.kind === 'extra' && p.status === 'pending')
        .forEach((p) => {
          p.status = 'void';
        });
    } else if (operation === 'start') {
      const paid = album.paidRequests.find((p: any) => p.id === b.requestId && p.status === 'paid');
      if (paid) {
        paid.status = 'processing';
        album.markModified('paidRequests');
        album.status = 'revising';
        order.status = 'shot';
      } else if (album.status === 'queued') album.status = 'retouching';
      else if (album.status !== 'revising')
        throw new WorkflowProblem(409, 'Chưa đủ điều kiện bắt đầu retouch.');
    } else if (operation === 'deliver') {
      if (!['retouching', 'revising'].includes(album.status))
        throw new WorkflowProblem(409, 'Chỉ giao khi đang retouch.');
      if (order.refundDue > 0)
        throw new WorkflowProblem(409, 'Đối soát khoản cần hoàn trước khi bàn giao.');
      const pendingFeedback = album.feedbackRounds.find(
        (r: any) => r.version === album.deliveryVersion,
      );
      if (pendingFeedback?.items.some((i: any) => !i.resolved))
        throw new WorkflowProblem(409, 'Đánh dấu xử lý tất cả góp ý trước khi giao.');
      if (
        album.paidRequests.some(
          (r: any) => r.status === 'processing' && r.items.some((i: any) => !i.resolved),
        )
      )
        throw new WorkflowProblem(409, 'Xử lý tất cả góp ý có phí trước khi giao.');
      const latest = album.selections[album.selections.length - 1];
      const stem = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase();
      if (
        !latest ||
        source!.images.length !== latest.photos.length ||
        latest.photos.some(
          (p: any) => !source!.images.some((i) => stem(i.name) === stem(p.name)),
        ) ||
        new Set(source!.images.map((i) => stem(i.name))).size !== source!.images.length
      )
        throw new WorkflowProblem(
          409,
          'Ảnh retouch cần đủ danh sách đã chốt và giữ tên file gốc (có thể đổi đuôi).',
        );
      album.deliveryVersion += 1;
      for (const [index, image] of source!.images.entries())
        await Photo.create(
          [{ album: album._id, version: album.deliveryVersion, drive: image, order: index }],
          { session },
        );
      album.deliveries.push({
        version: album.deliveryVersion,
        at: new Date(),
        actor: String(actor._id),
      });
      album.paidRequests.forEach((p: any) => {
        if (p.status === 'processing') p.status = 'resolved';
      });
      album.markModified('paidRequests');
      album.status = 'delivered';
    } else if (operation === 'feedback' || operation === 'request-extra') {
      if (
        !['delivered', 'completed'].includes(album.status) ||
        b.deliveryVersion !== album.deliveryVersion
      )
        throw new WorkflowProblem(409, 'Chỉ phản hồi bản bàn giao mới nhất.');
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 500)
        throw new WorkflowProblem(400, 'Cần ít nhất một góp ý.');
      const seen = new Set<string>();
      const items = [];
      for (const item of b.items) {
        const photoId = objectId(item.photoId);
        if (
          seen.has(photoId) ||
          !(await Photo.exists({
            _id: photoId,
            album: album._id,
            version: album.deliveryVersion,
          }).session(session))
        )
          throw new WorkflowProblem(400, 'Ảnh góp ý không đúng phiên bản hoặc bị trùng.');
        seen.add(photoId);
        items.push({ photoId, note: text(item.note, 2000), resolved: false });
      }
      if (operation === 'feedback') {
        if (album.status !== 'delivered' || album.feedbackRounds.length >= 2)
          throw new WorkflowProblem(409, 'Đã hết vòng miễn phí; gửi yêu cầu có phí.');
        album.feedbackRounds.push({
          id: randomUUID(),
          round: album.feedbackRounds.length + 1,
          version: album.deliveryVersion,
          at: new Date(),
          items,
        });
        album.status = 'revising';
      } else {
        if (album.feedbackRounds.length < 2 && album.status !== 'completed')
          throw new WorkflowProblem(409, 'Bạn vẫn còn vòng feedback miễn phí.');
        if (album.paidRequests.some((p: any) => !['resolved', 'declined'].includes(p.status)))
          throw new WorkflowProblem(409, 'Đang có yêu cầu phát sinh chưa xong.');
        album.paidRequests.push({
          id: randomUUID(),
          version: album.deliveryVersion,
          items,
          status: 'requested',
          at: new Date(),
        });
      }
    } else if (operation === 'resolve') {
      const round = [...album.feedbackRounds, ...album.paidRequests].find(
        (r: any) => r.id === b.roundId,
      );
      const item = round?.items.find((i: any) => i.photoId === b.photoId);
      if (
        !item ||
        round.version !== album.deliveryVersion ||
        !['revising', 'retouching'].includes(album.status)
      )
        throw new WorkflowProblem(409, 'Góp ý không còn được xử lý.');
      item.resolved = b.resolved === true;
      album.markModified('feedbackRounds');
      album.markModified('paidRequests');
    } else if (operation === 'quote') {
      if (!admin(actor)) throw new WorkflowProblem(403, 'Chỉ admin được báo phí.');
      const request = album.paidRequests.find(
        (r: any) => r.id === b.requestId && ['requested', 'quoted'].includes(r.status),
      );
      if (!request || !Number.isSafeInteger(b.amount) || b.amount < 1 || b.amount > 100000000)
        throw new WorkflowProblem(400, 'Yêu cầu/giá không hợp lệ.');
      request.amount = b.amount;
      request.terms = text(b.terms, 2000);
      request.status = 'quoted';
      album.markModified('paidRequests');
    } else if (operation === 'accept-quote') {
      const request = album.paidRequests.find(
        (r: any) => r.id === b.requestId && r.status === 'quoted',
      );
      if (!request || b.accepted !== true || b.amount !== request.amount)
        throw new WorkflowProblem(409, 'Đồng ý báo giá hiện tại.');
      const payment = addRequest(
        order,
        'revision',
        request.amount,
        new Date(Date.now() + 7 * 86400000),
      );
      request.reference = payment.reference;
      request.status = 'awaiting_payment';
      request.acceptedAt = new Date();
      album.markModified('paidRequests');
      if (order.status === 'completed') order.status = 'shot';
    } else if (operation === 'decline-quote') {
      const request = album.paidRequests.find(
        (r: any) => r.id === b.requestId && ['requested', 'quoted'].includes(r.status),
      );
      if (!request) throw new WorkflowProblem(409, 'Không thể hủy yêu cầu này.');
      request.status = 'declined';
      album.markModified('paidRequests');
    } else if (operation === 'accept') {
      if (
        album.status !== 'delivered' ||
        b.deliveryVersion !== album.deliveryVersion ||
        album.paidRequests.some((r: any) => !['resolved', 'declined'].includes(r.status))
      )
        throw new WorkflowProblem(409, 'Bản giao/yêu cầu phát sinh chưa hoàn tất.');
      album.status = 'completed';
      order.status = 'completed';
    } else if (operation === 'share') {
      if (!admin(actor) || !albumOpen(order) || album.status === 'draft')
        throw new WorkflowProblem(403, 'Chưa thể chia sẻ.');
      album.share = {
        publicId: randomUUID().replace(/-/g, ''),
        tokenHash: hash(shareToken!),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      };
    } else if (operation === 'revoke') {
      if (!admin(actor)) throw new WorkflowProblem(403, 'Chỉ admin thu hồi link.');
      album.share = undefined;
    } else if (operation === 'download-policy') {
      if (!admin(actor) || typeof b.allowed !== 'boolean')
        throw new WorkflowProblem(403, 'Chỉ admin cấu hình tải ảnh.');
      album.allowDownload = b.allowed;
    } else throw new WorkflowProblem(404, 'Không có thao tác album này.');
    await album.save({ session });
    order.version += 1;
    event(
      order,
      `album.${operation}`,
      (
        {
          sync: 'Đã đồng bộ ảnh chỉnh màu.',
          publish: 'Đã mở album chọn ảnh.',
          photo: 'Đã lưu lựa chọn và ghi chú ảnh.',
          finalize: 'Đã chốt ảnh retouch.',
          reopen: 'Studio đã mở lại lựa chọn.',
          start: 'Ekip bắt đầu retouch.',
          deliver: 'Đã gửi bản ảnh retouch mới.',
          feedback: 'Đã gửi một vòng góp ý.',
          'request-extra': 'Khách yêu cầu chỉnh thêm.',
          resolve: 'Đã cập nhật xử lý góp ý.',
          quote: 'Studio đã gửi báo phí chỉnh thêm.',
          'accept-quote': 'Khách đã đồng ý phí chỉnh thêm.',
          'decline-quote': 'Đã hủy yêu cầu chỉnh thêm.',
          accept: 'Khách xác nhận ảnh đạt yêu cầu.',
          share: 'Đã tạo link album chỉ xem.',
          revoke: 'Đã thu hồi link album.',
          'download-policy': 'Đã cập nhật quyền tải ảnh.',
        } as Record<string, string>
      )[operation] || 'Album đã được cập nhật.',
      actor,
    );
    await order.save({ session });
    await enqueueConceptEmail(order, session);
    return { album, token: shareToken };
  });
}
export async function photoFor(
  access: Awaited<ReturnType<typeof albumAccess>>,
  photoId: string,
  download = false,
  guest = false,
) {
  if (download && (guest || !access.album.allowDownload))
    throw new WorkflowProblem(403, 'Không được tải ảnh.');
  const photo = await Photo.findOne({ _id: objectId(photoId), album: access.album._id });
  if (!photo || !photo.available || (download && photo.version === 0))
    throw new WorkflowProblem(404, 'Không tìm thấy ảnh bàn giao.');
  return photo;
}
export { readAlbumPhoto as readConceptPhoto };
