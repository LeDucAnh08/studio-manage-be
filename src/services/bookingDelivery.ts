import path from 'node:path';
import { mkdir, stat, unlink, readdir, realpath } from 'node:fs/promises';
import { ClientSession, isValidObjectId } from 'mongoose';
import Booking from '../models/Booking';
import BookingWorkflow from '../models/BookingWorkflow';
import Photo from '../models/BookingDeliveryPhoto';
import { withResourceTransaction, WorkflowProblem } from './workflowTransactions';
import { packageMediaDirectory } from './packageMedia';
const publicDirectories = () => [
  packageMediaDirectory(),
  path.resolve(__dirname, '../../../frontend/public'),
  path.resolve(__dirname, '../../../frontend/dist'),
];
const folded = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
const within = (directory: string, root: string) =>
  folded(directory) === folded(root) || folded(directory).startsWith(folded(root) + path.sep);

export function deliveryDirectory() {
  const directory = process.env.PRIVATE_DELIVERY_DIR
    ? path.resolve(__dirname, '../..', process.env.PRIVATE_DELIVERY_DIR)
    : path.resolve(__dirname, '../../../.data/private-delivery');
  if (
    [
      path.parse(directory).root,
      path.resolve(__dirname, '../..'),
      path.resolve(__dirname, '../../..'),
      path.resolve(__dirname, '../../../frontend'),
    ].includes(directory)
  )
    throw new Error('Choose a dedicated private delivery directory');
  for (const publicRoot of publicDirectories()) {
    if (within(directory, publicRoot))
      throw new Error('Private delivery storage cannot be inside public media');
  }
  return directory;
}
export async function ensureDeliveryStorage() {
  const directory = deliveryDirectory();
  await mkdir(directory, { recursive: true });
  const actual = await realpath(directory);
  for (const root of publicDirectories()) {
    const publicRoot = await realpath(root).catch(() => root);
    if (within(actual, publicRoot))
      throw new Error('Private delivery storage cannot resolve inside public media');
  }
  return directory;
}
export function deliveryFile(id: string, thumbnail = false) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new WorkflowProblem(400, 'Mã ảnh không hợp lệ.');
  return path.join(deliveryDirectory(), thumbnail ? `${id}-thumb.webp` : `${id}.jpg`);
}
export const deliveryPhotoDto = (photo: any) => ({
  id: String(photo._id),
  source: 'local' as const,
  name: photo.name,
  width: photo.width,
  height: photo.height,
});

export async function deliveryAccess(
  bookingId: string,
  actor: { _id: unknown; roles: number[] },
  session?: ClientSession,
  write = false,
) {
  if (!isValidObjectId(bookingId)) throw new WorkflowProblem(404, 'Không tìm thấy đơn.');
  const booking = await Booking.findById(bookingId).session(session ?? null);
  const workflow = await BookingWorkflow.findOne({ booking: bookingId }).session(session ?? null);
  if (!booking || !workflow) throw new WorkflowProblem(404, 'Không tìm thấy hồ sơ bàn giao.');
  const admin = actor.roles.some((role) => role === 0 || role === 1);
  const assigned =
    actor.roles.includes(3) &&
    [
      workflow.assignedPhotographer,
      ...(workflow.assignedSupportPhotographers || []),
      ...(workflow.resources?.photographers || []),
    ].some((id) => String(id) === String(actor._id));
  const owner = actor.roles.includes(6) && String(booking.client) === String(actor._id);
  if (!admin && !assigned && !owner)
    throw new WorkflowProblem(404, 'Không tìm thấy hồ sơ bàn giao.');
  if (write && !admin && !assigned)
    throw new WorkflowProblem(403, 'Chỉ ekip phụ trách được tải ảnh.');
  if (
    write &&
    (booking.status !== 'approved' ||
      !workflow.resources?.schedule ||
      !['editing', 'revision_requested'].includes(workflow.lifecycle))
  )
    throw new WorkflowProblem(409, 'Chỉ tải ảnh khi đơn đang hậu kỳ hoặc cần chỉnh sửa.');
  return { booking, workflow, staff: admin || assigned };
}

export async function validateDeliveryPhotos(
  input: unknown,
  bookingId: unknown,
  session: ClientSession,
) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 500 ||
    input.some((id) => typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) ||
    new Set(input).size !== input.length
  )
    throw new WorkflowProblem(400, 'Chọn từ 1 đến 500 ảnh hợp lệ, không trùng lặp.');
  const photos = await Photo.find({
    _id: { $in: input },
    booking: bookingId,
    deletedAt: { $exists: false },
  }).session(session);
  if (photos.length !== input.length)
    throw new WorkflowProblem(409, 'Có ảnh đã bị xóa hoặc không thuộc đơn này.');
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

export async function removeDeliveryFiles(id: string) {
  await Promise.all(
    [deliveryFile(id), deliveryFile(id, true)].map((file) =>
      unlink(file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.error('[Delivery photo] File cleanup deferred:', id);
      }),
    ),
  );
}

export async function cleanupDeliveryPhotos() {
  const cutoff = new Date(Date.now() - 7 * 86400000);
  await withResourceTransaction(async (session) => {
    await Photo.updateMany(
      {
        publishedVersions: { $size: 0 },
        deletedAt: { $exists: false },
        createdAt: { $lt: cutoff },
      },
      { $set: { deletedAt: new Date() } },
      { session },
    );
  });
  const directory = await ensureDeliveryStorage();
  await mkdir(directory, { recursive: true });
  let count = 0;
  for (const name of await readdir(directory)) {
    const match = name.match(/^([a-f0-9]{24})(?:-thumb)?\.(?:jpg|webp)$/);
    if (!match) continue;
    const file = path.join(directory, name);
    if ((await stat(file)).mtime > cutoff) continue;
    const photo = await Photo.findById(match[1]).select('deletedAt');
    if (!photo || photo.deletedAt) {
      await unlink(file);
      count++;
    }
  }
  const staging = path.join(directory, '.staging');
  await mkdir(staging, { recursive: true });
  for (const name of await readdir(staging)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const file = path.join(staging, name);
    if ((await stat(file)).mtimeMs < Date.now() - 86400000) {
      await unlink(file);
      count++;
    }
  }
  return count;
}
