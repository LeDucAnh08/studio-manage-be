import { Request, Response } from 'express';
import Feedback from '../models/Feedback';
import type { FeedbackResponse } from '../types/dto';
import { sendResponse } from '../utils/response';
import Customer from '../models/Customer';

export const getAll = async (req: Request, res: Response): Promise<void> => {
  const { page = '1', limit = '20', isRead } = req.query as Record<string, string>;
  const query: Record<string, unknown> = {};
  if (isRead === 'true') query.isRead = true;
  else if (isRead === 'false') query.isRead = false;

  const skip = (Number(page) - 1) * Number(limit);
  const [data, total, totalUnread] = await Promise.all([
    Feedback.find(query)
      .populate('customer')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean<FeedbackResponse[]>(),
    Feedback.countDocuments({}),
    Feedback.countDocuments({ isRead: false }),
  ]);
  const totalRead = total - totalUnread;
  sendResponse(res, 200, true, 'OK', data, {
    total,
    totalRead,
    totalUnread,
    page: Number(page),
    limit: Number(limit),
  });
};

export const markRead = async (req: Request, res: Response): Promise<void> => {
  const feedback = await Feedback.findByIdAndUpdate(
    req.params.id,
    { isRead: req.body?.isRead ?? true },
    { new: true },
  );
  if (!feedback) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Cập nhật thành công', feedback);
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const linked = await Feedback.findById(req.params.id).select('workflowBooking').lean();
  if (linked?.workflowBooking) {
    sendResponse(res, 409, false, 'Booking feedback cannot be deleted through the legacy route');
    return;
  }
  const feedback = await Feedback.findByIdAndDelete(req.params.id);
  if (!feedback) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Đã xóa feedback');
};

// Public: submit feedback
export const submit = async (req: Request, res: Response): Promise<void> => {
  const { customer, access, phone, crewFeedback, albumFeedback, content, suggestion } = req.body;

  if (customer) {
    const matchedCustomer = await Customer.findById(customer).select('+publicAccessToken');
    if (!matchedCustomer?.publicAccessToken || matchedCustomer.publicAccessToken !== access) {
      sendResponse(res, 404, false, 'Không tìm thấy form hoặc link không hợp lệ');
      return;
    }
  }

  const crewRating = Number(crewFeedback?.rating);
  const albumRating = Number(albumFeedback?.rating);

  if (!crewRating || !albumRating) {
    sendResponse(res, 400, false, 'crewFeedback.rating và albumFeedback.rating là bắt buộc');
    return;
  }
  if (crewRating < 1 || crewRating > 5 || albumRating < 1 || albumRating > 5) {
    sendResponse(res, 400, false, 'Đánh giá phải từ 1 đến 5');
    return;
  }
  if (!crewFeedback?.description?.trim() || !albumFeedback?.description?.trim()) {
    sendResponse(res, 400, false, 'Vui lòng chia sẻ thêm về ekip và album');
    return;
  }

  const feedback = await Feedback.create({
    customer: customer || undefined,
    phone,
    crewFeedback: {
      rating: crewRating,
      description: crewFeedback.description.trim(),
    },
    albumFeedback: {
      rating: albumRating,
      description: albumFeedback.description.trim(),
    },
    content,
    suggestion,
  });
  sendResponse(res, 201, true, 'Gửi đánh giá thành công', { _id: feedback._id });
};
