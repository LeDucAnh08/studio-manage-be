import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { isValidObjectId } from 'mongoose';
import AccountRequest from '../models/AccountRequest';
import User, { type UserRole } from '../models/User';
import { sendResponse } from '../utils/response';
import { isDuplicateKeyError, normalizeUsername, trimmedText } from '../utils/input';

const allowedRequestedRoles: UserRole[] = [2, 3, 4, 5];

export const submit = async (req: Request, res: Response): Promise<void> => {
  const { username, name, phone, note, password, requestedRole } = req.body as {
    username?: string;
    name?: string;
    phone?: string;
    note?: string;
    password?: string;
    requestedRole?: number;
  };
  const normalizedUsername = normalizeUsername(username);
  const normalizedName = trimmedText(name, 100);
  const normalizedPhone = trimmedText(phone ?? '', 25, false);
  const normalizedNote = trimmedText(note ?? '', 1000, false);
  if (
    !normalizedUsername ||
    !normalizedName ||
    normalizedPhone === null ||
    normalizedNote === null ||
    (normalizedPhone && !/^[+\d() .-]{8,25}$/.test(normalizedPhone)) ||
    typeof password !== 'string' ||
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    sendResponse(
      res,
      400,
      false,
      'Kiểm tra họ tên, tên đăng nhập, số điện thoại và mật khẩu từ 8 ký tự.',
    );
    return;
  }
  if (!allowedRequestedRoles.includes(requestedRole as UserRole)) {
    sendResponse(res, 400, false, 'Vai trò yêu cầu không hợp lệ');
    return;
  }
  const exists =
    (await User.exists({ username: normalizedUsername })) ||
    (await AccountRequest.exists({ username: normalizedUsername, status: 'pending' }));
  if (exists) {
    sendResponse(res, 409, false, 'Tên đăng nhập đã được sử dụng hoặc đang chờ duyệt');
    return;
  }
  try {
    await AccountRequest.create({
      username: normalizedUsername,
      name: normalizedName,
      phone: normalizedPhone || undefined,
      note: normalizedNote || undefined,
      passwordHash: await bcrypt.hash(password, 12),
      requestedRole,
    });
    sendResponse(
      res,
      201,
      true,
      'Yêu cầu cấp tài khoản đã được gửi. Quản trị viên sẽ xét duyệt sớm.',
    );
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      sendResponse(res, 409, false, 'Tên đăng nhập đã được sử dụng hoặc đang chờ duyệt');
      return;
    }
    throw error;
  }
};

export const getAll = async (_req: Request, res: Response): Promise<void> => {
  const requests = await AccountRequest.find()
    .select('-passwordHash -reviewLockToken -reviewLockExpiresAt')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  sendResponse(res, 200, true, 'OK', requests);
};

export const review = async (req: Request, res: Response): Promise<void> => {
  const { status, roles } = req.body as {
    status?: 'approved' | 'rejected';
    roles?: UserRole[];
  };
  const reviewNote = trimmedText(req.body.note ?? '', 1000, false);
  if (status !== 'approved' && status !== 'rejected') {
    sendResponse(res, 400, false, 'Trạng thái xét duyệt không hợp lệ');
    return;
  }
  if (
    !isValidObjectId(req.params.id) ||
    reviewNote === null ||
    (status === 'rejected' && !reviewNote)
  ) {
    sendResponse(res, 400, false, 'Yêu cầu không hợp lệ hoặc chưa có lý do từ chối');
    return;
  }

  const uniqueRoles = roles ? [...new Set(roles)] : undefined;
  if (
    uniqueRoles &&
    (!uniqueRoles.length || uniqueRoles.some((role) => !allowedRequestedRoles.includes(role)))
  ) {
    sendResponse(res, 400, false, 'Vai trò cấp cho tài khoản không hợp lệ');
    return;
  }

  const now = new Date();
  const lockToken = randomUUID();
  const request = await AccountRequest.findOneAndUpdate(
    {
      _id: req.params.id,
      status: 'pending',
      $or: [{ reviewLockExpiresAt: { $exists: false } }, { reviewLockExpiresAt: { $lte: now } }],
    },
    {
      $set: {
        reviewLockToken: lockToken,
        reviewLockExpiresAt: new Date(now.getTime() + 2 * 60 * 1000),
      },
    },
    { new: true },
  ).select('+passwordHash');

  if (!request) {
    sendResponse(res, 409, false, 'Yêu cầu đã được xử lý hoặc đang được quản trị viên khác xử lý');
    return;
  }

  const releaseLock = () =>
    AccountRequest.updateOne(
      { _id: request._id, reviewLockToken: lockToken, status: 'pending' },
      { $unset: { reviewLockToken: 1, reviewLockExpiresAt: 1 } },
    );

  try {
    if (status === 'approved') {
      if (!request.passwordHash) {
        await releaseLock();
        sendResponse(res, 409, false, 'Yêu cầu không còn thông tin xác thực để cấp tài khoản');
        return;
      }
      const assignedRoles = uniqueRoles ?? [request.requestedRole];
      await User.collection.updateOne(
        { sourceAccountRequest: request._id },
        {
          $setOnInsert: {
            username: request.username,
            name: request.name,
            password: request.passwordHash,
            roles: assignedRoles,
            isActive: true,
            sourceAccountRequest: request._id,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    }

    const finalized = await AccountRequest.findOneAndUpdate(
      { _id: request._id, reviewLockToken: lockToken, status: 'pending' },
      {
        $set: {
          status,
          reviewNote: reviewNote || undefined,
          reviewedBy: req.user!._id,
          reviewedAt: now,
        },
        $unset: { passwordHash: 1, reviewLockToken: 1, reviewLockExpiresAt: 1 },
      },
      { new: true },
    );

    if (!finalized) {
      sendResponse(res, 409, false, 'Yêu cầu đã thay đổi. Vui lòng tải lại.');
      return;
    }
    sendResponse(res, 200, true, status === 'approved' ? 'Đã cấp tài khoản' : 'Đã từ chối yêu cầu');
  } catch (error) {
    await releaseLock();
    if (isDuplicateKeyError(error)) {
      sendResponse(res, 409, false, 'Tên đăng nhập đã tồn tại');
      return;
    }
    throw error;
  }
};
