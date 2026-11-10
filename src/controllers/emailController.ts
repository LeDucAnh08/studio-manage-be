import { randomBytes } from 'crypto';
import { Request, Response } from 'express';
import User from '../models/User';
import EmailOutbox from '../models/EmailOutbox';
import { sendResponse } from '../utils/response';
import { withResourceTransaction, WorkflowProblem } from '../services/workflowTransactions';
import {
  emailConfig,
  emailHash,
  normalizeEmail,
  verificationToken,
  enqueuePendingDepositEmails,
} from '../services/email';

const customer = (req: Request) => {
  if (!req.user?.roles.includes(6))
    throw new WorkflowProblem(403, 'Chức năng dành cho tài khoản khách hàng.');
};
export async function requestEmailVerification(req: Request, res: Response) {
  try {
    customer(req);
    const email = normalizeEmail(req.body?.email);
    if (!email) throw new WorkflowProblem(400, 'Nhập địa chỉ email hợp lệ.');
    const config = emailConfig();
    if (!config) throw new WorkflowProblem(503, 'Tính năng email tạm chưa khả dụng.');
    const user = await withResourceTransaction(async (session) => {
      const user = await User.findById(req.user!._id).select('+emailVerification').session(session);
      if (!user || !user.isActive) throw new WorkflowProblem(403, 'Tài khoản không hoạt động.');
      if (user.email === email && user.emailVerifiedAt)
        throw new WorkflowProblem(409, 'Email đã được xác minh.');
      const previous = user.emailVerification,
        now = new Date();
      if (previous && +now - +previous.requestedAt < 60000)
        throw new WorkflowProblem(429, 'Vui lòng chờ 60 giây trước khi gửi lại email.');
      const sameWindow = previous && +now - +previous.windowAt < 86400000;
      if (sameWindow && previous.count >= 10)
        throw new WorkflowProblem(429, 'Đã đạt giới hạn xác minh email trong ngày.');
      const nonce = randomBytes(32).toString('hex');
      const tokenHash = emailHash(verificationToken(String(user._id), email, nonce));
      const expiresAt = new Date(+now + 60 * 60 * 1000);
      user.email = email;
      user.emailVerifiedAt = undefined;
      user.emailVerification = {
        tokenHash,
        expiresAt,
        requestedAt: now,
        windowAt: sameWindow ? previous.windowAt : now,
        count: sameWindow ? previous.count + 1 : 1,
      };
      await user.save({ session });
      await EmailOutbox.create(
        [
          {
            dedupeKey: `verify-email:${user._id}:${nonce}`,
            kind: 'verify_email',
            user: user._id,
            to: email,
            mode: config.mode,
            payload: { origin: config.origin, from: config.from, nonce, expiresAt },
          },
        ],
        { session },
      );
      return { email: user.email, emailVerifiedAt: null };
    });
    sendResponse(res, 202, true, 'Đã tiếp nhận yêu cầu xác minh email.', {
      ...user,
      testMode: config.mode === 'test',
    });
  } catch (error) {
    const problem = error as WorkflowProblem;
    sendResponse(
      res,
      problem.status || 503,
      false,
      problem.status ? problem.message : 'Tính năng email tạm chưa khả dụng.',
    );
  }
}

export async function confirmEmailVerification(req: Request, res: Response) {
  try {
    customer(req);
    const token = req.body?.token;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new WorkflowProblem(400, 'Đường dẫn xác minh không hợp lệ.');
    const user = await withResourceTransaction(async (session) => {
      const user = await User.findOneAndUpdate(
        {
          _id: req.user!._id,
          isActive: true,
          'emailVerification.tokenHash': emailHash(token),
          'emailVerification.expiresAt': { $gt: new Date() },
        },
        { $set: { emailVerifiedAt: new Date() }, $unset: { 'emailVerification.tokenHash': 1 } },
        { new: true, session },
      );
      if (!user)
        throw new WorkflowProblem(
          400,
          'Đường dẫn đã hết hạn, đã sử dụng hoặc không thuộc tài khoản đang đăng nhập.',
        );
      await enqueuePendingDepositEmails(String(user._id), session);
      return { email: user.email, emailVerifiedAt: user.emailVerifiedAt };
    });
    sendResponse(res, 200, true, 'Đã xác minh email nhận thông báo.', user);
  } catch (error) {
    const problem = error as WorkflowProblem;
    sendResponse(
      res,
      problem.status || 503,
      false,
      problem.status ? problem.message : 'Chưa thể xác minh. Vui lòng thử lại.',
    );
  }
}
