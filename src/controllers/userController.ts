import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import User, { ACTIVE_ROLES, USER_PUBLIC_FIELDS } from '../models/User';
import type { UserRole } from '../models/User';
import Schedule from '../models/Schedule';
import { sendResponse } from '../utils/response';
import { isDuplicateKeyError, normalizeUsername, trimmedText } from '../utils/input';

const allRoles = ACTIVE_ROLES;

const canManageUser = (actorRoles: number[], targetRoles: number[]): boolean =>
  actorRoles.includes(0) || !targetRoles.includes(0);

const canAssignRoles = (actorRoles: number[], roles: UserRole[]): boolean =>
  actorRoles.includes(0) || !roles.includes(0);

const parseRoles = (value: unknown): UserRole[] | null => {
  if (!Array.isArray(value)) return null;
  const roles = [...new Set(value)];
  if (
    !roles.length ||
    roles.some((role) => typeof role !== 'number' || !allRoles.includes(role as UserRole)) ||
    (roles.includes(6) && roles.length > 1)
  ) {
    return null;
  }
  return roles as UserRole[];
};

export const getPhotographers = async (_req: Request, res: Response): Promise<void> => {
  const users = await User.find({ roles: { $in: [3] }, isActive: true })
    .select('_id username name roles')
    .sort({ username: 1 });
  sendResponse(res, 200, true, 'OK', users);
};

export const getPhotographersManage = async (_req: Request, res: Response): Promise<void> => {
  const shiftedNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const vietnamTodayStart = new Date(
    Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate()) -
      7 * 60 * 60 * 1000,
  );
  const [users, schedules] = await Promise.all([
    User.find({ roles: { $in: [3] } })
      .select(USER_PUBLIC_FIELDS)
      .sort({ isActive: -1, name: 1, username: 1 })
      .lean(),
    Schedule.find({ status: { $ne: 'cancelled' } })
      .select('leadPhotographer supportPhotographers shootDate status')
      .lean(),
  ]);

  const statsMap = new Map<string, { total: number; upcoming: number; completed: number }>();
  const ensureStats = (id: string) => {
    let entry = statsMap.get(id);
    if (!entry) {
      entry = { total: 0, upcoming: 0, completed: 0 };
      statsMap.set(id, entry);
    }
    return entry;
  };

  for (const s of schedules) {
    const assigned = new Set<string>(
      [s.leadPhotographer, ...(s.supportPhotographers ?? [])].filter(Boolean).map(String),
    );
    const isUpcoming = s.status !== 'completed' && new Date(s.shootDate) >= vietnamTodayStart;
    const isCompleted = s.status === 'completed';
    for (const id of assigned) {
      const entry = ensureStats(id);
      entry.total += 1;
      if (isUpcoming) entry.upcoming += 1;
      if (isCompleted) entry.completed += 1;
    }
  }

  sendResponse(
    res,
    200,
    true,
    'OK',
    users.map((u) => ({
      ...u,
      scheduleStats: statsMap.get(String(u._id)) ?? { total: 0, upcoming: 0, completed: 0 },
    })),
  );
};

export const getCoordinators = async (_req: Request, res: Response): Promise<void> => {
  const users = await User.find({ roles: { $in: [0, 1] }, isActive: true })
    .select('_id username name roles')
    .sort({ username: 1 });
  sendResponse(res, 200, true, 'OK', users);
};
export const getAll = async (_req: Request, res: Response): Promise<void> => {
  const users = await User.find().select(USER_PUBLIC_FIELDS).sort({ createdAt: -1 }).lean();
  sendResponse(res, 200, true, 'OK', users);
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  if (!isValidObjectId(req.params.id)) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  const user = await User.findById(req.params.id).select(USER_PUBLIC_FIELDS).lean();
  if (!user) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'OK', user);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const username = normalizeUsername(req.body.username);
  const name = trimmedText(req.body.name ?? '', 100, false);
  const roles = parseRoles(req.body.roles);
  const password = req.body.password;
  const isActive = req.body.isActive === undefined ? true : req.body.isActive;
  if (
    !username ||
    name === null ||
    !roles ||
    typeof password !== 'string' ||
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    typeof isActive !== 'boolean'
  ) {
    sendResponse(res, 400, false, 'Thông tin tài khoản hoặc vai trò không hợp lệ');
    return;
  }
  if (!canAssignRoles(req.user!.roles, roles)) {
    sendResponse(res, 403, false, 'Chỉ Superadmin mới có thể cấp vai trò Superadmin');
    return;
  }
  const exists = await User.findOne({ username });
  if (exists) {
    sendResponse(res, 409, false, 'Username already exists');
    return;
  }
  let user;
  try {
    user = await User.create({ username, name: name || undefined, password, roles, isActive });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      sendResponse(res, 409, false, 'Username already exists');
      return;
    }
    throw error;
  }
  sendResponse(res, 201, true, 'Tạo người dùng thành công', {
    _id: user._id,
    username: user.username,
    name: user.name,
    roles: user.roles,
    isActive: user.isActive,
  });
};

export const update = async (req: Request, res: Response): Promise<void> => {
  if (!isValidObjectId(req.params.id)) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  const username = normalizeUsername(req.body.username);
  const name = trimmedText(req.body.name ?? '', 100, false);
  const roles = parseRoles(req.body.roles);
  const password = req.body.password;
  const isActive = req.body.isActive;
  if (
    !username ||
    name === null ||
    !roles ||
    (password !== undefined &&
      (typeof password !== 'string' ||
        password.length < 8 ||
        Buffer.byteLength(password, 'utf8') > 72)) ||
    typeof isActive !== 'boolean'
  ) {
    sendResponse(res, 400, false, 'Thông tin tài khoản hoặc vai trò không hợp lệ');
    return;
  }
  const user = await User.findById(req.params.id).select('+password');
  if (!user) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  if (!canManageUser(req.user!.roles, user.roles) || !canAssignRoles(req.user!.roles, roles)) {
    sendResponse(res, 403, false, 'Bạn không có quyền thay đổi tài khoản Superadmin');
    return;
  }

  user.username = username;
  user.name = name || undefined;
  user.roles = roles;
  user.isActive = isActive;
  if (password) user.password = password;
  try {
    await user.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      sendResponse(res, 409, false, 'Username already exists');
      return;
    }
    throw error;
  }

  sendResponse(res, 200, true, 'Cập nhật thành công', {
    _id: user._id,
    username: user.username,
    name: user.name,
    roles: user.roles,
    isActive: user.isActive,
  });
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  if (!isValidObjectId(req.params.id)) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  if (req.user!._id.toString() === req.params.id) {
    sendResponse(res, 409, false, 'Không thể xoá tài khoản đang đăng nhập');
    return;
  }
  const user = await User.findById(req.params.id);
  if (!user) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  if (!canManageUser(req.user!.roles, user.roles)) {
    sendResponse(res, 403, false, 'Bạn không có quyền xoá tài khoản Superadmin');
    return;
  }
  await user.deleteOne();
  sendResponse(res, 200, true, 'Đã xóa người dùng');
};
