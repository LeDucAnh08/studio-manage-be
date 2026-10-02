import { Request, Response } from 'express';
import Customer from '../models/Customer';
import { resolveCurrentSeason } from '../utils/seasonCache';
import { sendResponse } from '../utils/response';
import crypto from 'crypto';
import BookingWorkflow from '../models/BookingWorkflow';
import Schedule from '../models/Schedule';
import {
  withResourceTransaction,
  WorkflowProblem,
  workflowEnabled,
} from '../services/workflowTransactions';

export const getAll = async (req: Request, res: Response): Promise<void> => {
  const { search, page = '1', limit = '20', season } = req.query as Record<string, string>;
  const query: Record<string, unknown> = search ? { $text: { $search: search } } : {};
  if (season) query.season = season;
  const skip = (Number(page) - 1) * Number(limit);
  const [data, total] = await Promise.all([
    Customer.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Customer.countDocuments(query),
  ]);
  sendResponse(res, 200, true, 'OK', data, { total, page: Number(page), limit: Number(limit) });
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  const customer = await Customer.findById(req.params.id).lean();
  if (!customer) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'OK', customer);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const payload = { ...req.body, createdBy: req.user!._id };
  if (!payload.season) {
    payload.season = await resolveCurrentSeason();
  }
  const customer = await Customer.create(payload);
  sendResponse(res, 201, true, 'Tạo khách hàng thành công', customer);
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const updateData = { ...req.body };
  delete updateData.publicAccessToken;
  delete updateData.createdBy;
  delete updateData._id;
  delete updateData.__v;
  const customer = await Customer.findByIdAndUpdate(req.params.id, updateData, {
    new: true,
    runValidators: true,
  }).lean();
  if (!customer) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Cập nhật thành công', customer);
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  let customer: any;
  const removeCustomer = async (session?: any) => {
    const bookingQuery = BookingWorkflow.exists({ customer: req.params.id });
    const scheduleQuery = Schedule.exists({ customer: req.params.id });
    if (session) {
      bookingQuery.session(session);
      scheduleQuery.session(session);
    }
    if ((await bookingQuery) || (await scheduleQuery))
      throw new WorkflowProblem(
        409,
        'This customer is linked to a booking or schedule and cannot be deleted',
      );
    const query = Customer.findByIdAndDelete(req.params.id);
    if (session) query.session(session);
    customer = await query;
  };
  try {
    if (workflowEnabled())
      await withResourceTransaction(async (session) => removeCustomer(session));
    else await removeCustomer();
  } catch (error) {
    const problem = error as WorkflowProblem;
    sendResponse(res, problem.status ?? 500, false, problem.message ?? 'Internal server error');
    return;
  }
  if (!customer) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Đã xóa khách hàng');
};

export const getPublicLink = async (req: Request, res: Response): Promise<void> => {
  const customer = await Customer.findById(req.params.id).select('+publicAccessToken');
  if (!customer) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  if (await BookingWorkflow.exists({ customer: customer._id })) {
    sendResponse(res, 409, false, 'Use the booking member intake link for this customer');
    return;
  }
  if (!customer.publicAccessToken) {
    customer.publicAccessToken = crypto.randomBytes(24).toString('hex');
    await customer.save();
  }
  sendResponse(res, 200, true, 'OK', { token: customer.publicAccessToken });
};
