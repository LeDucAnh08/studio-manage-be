import { Request, Response } from 'express';
import Class from '../models/Class';
import { sendResponse } from '../utils/response';
import crypto from 'crypto';
import BookingWorkflow from '../models/BookingWorkflow';
import Schedule from '../models/Schedule';
import Student from '../models/Student';
import { isValidObjectId } from 'mongoose';
import {
  withResourceTransaction,
  WorkflowProblem,
  workflowEnabled,
} from '../services/workflowTransactions';

export const getAll = async (req: Request, res: Response): Promise<void> => {
  const { search, page = '1', limit = '20' } = req.query as Record<string, string>;
  const query: Record<string, unknown> = search ? { $text: { $search: search } } : {};
  const skip = (Number(page) - 1) * Number(limit);
  const [data, total] = await Promise.all([
    Class.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Class.countDocuments(query),
  ]);
  sendResponse(res, 200, true, 'OK', data, { total, page: Number(page), limit: Number(limit) });
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  const customer = await Class.findById(req.params.id).lean();
  if (!customer) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'OK', customer);
};

interface ClassStudent {
  _id: unknown;
  name: string;
  gender?: string;
  contact?: string;
  height?: number;
  weight?: number;
  pantsSize?: string;
  shirtSize?: string;
  notes?: string;
}

export const getStudents = async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  if (!isValidObjectId(id)) {
    sendResponse(res, 400, false, 'Mã lớp không hợp lệ.');
    return;
  }
  if (!(await Class.exists({ _id: id }))) {
    sendResponse(res, 404, false, 'Không tìm thấy lớp học.');
    return;
  }
  const workflow = await BookingWorkflow.findOne({ customer: id })
    .select('members')
    .lean<{ members: ClassStudent[] } | null>();
  // Booking members retain contact and clothing sizes separately from legacy notes.
  const members: ClassStudent[] = workflow
    ? (workflow.members ?? [])
    : await Student.find({ customer: id })
        .select('name gender height weight pantsSize shirtSize notes')
        .sort({ createdAt: 1, _id: 1 })
        .lean();
  const students = members.map((member) => ({
    _id: String(member._id),
    name: member.name,
    gender: member.gender,
    contact: member.contact,
    height: member.height,
    weight: member.weight,
    pantsSize: member.pantsSize,
    shirtSize: member.shirtSize,
    notes: member.notes,
  }));
  sendResponse(res, 200, true, 'OK', {
    source: workflow ? 'booking' : 'legacy',
    students,
  });
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const payload = { ...req.body, createdBy: req.user!._id };
  const customer = await Class.create(payload);
  sendResponse(res, 201, true, 'Tạo khách hàng thành công', customer);
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const updateData = { ...req.body };
  delete updateData.publicAccessToken;
  delete updateData.createdBy;
  delete updateData._id;
  delete updateData.__v;
  const customer = await Class.findByIdAndUpdate(req.params.id, updateData, {
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
    const query = Class.findByIdAndDelete(req.params.id);
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
  const customer = await Class.findById(req.params.id).select('+publicAccessToken');
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
