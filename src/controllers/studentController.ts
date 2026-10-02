import { Request, Response } from 'express';
import Student from '../models/Student';
import type { StudentResponse } from '../types/dto';
import { sendResponse } from '../utils/response';
import BookingWorkflow from '../models/BookingWorkflow';

export const getAll = async (req: Request, res: Response): Promise<void> => {
  const { customer, search, page = '1', limit = '50' } = req.query as Record<string, string>;
  const query: Record<string, unknown> = {};
  if (customer) query.customer = customer;
  if (search) query.$text = { $search: search };
  const skip = (Number(page) - 1) * Number(limit);
  const [data, total, totalMale, totalFemale] = await Promise.all([
    Student.find(query)
      .sort({ name: 1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('costumes')
      .lean<StudentResponse[]>(),
    Student.countDocuments(query),
    Student.countDocuments({ ...query, gender: 'male' }),
    Student.countDocuments({ ...query, gender: 'female' }),
  ]);
  sendResponse(res, 200, true, 'OK', data, {
    total,
    totalMale,
    totalFemale,
    page: Number(page),
    limit: Number(limit),
  });
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  const student = await Student.findById(req.params.id)
    .populate('costumes')
    .lean<StudentResponse | null>();
  if (!student) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'OK', student);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const created = await Student.create(req.body);
  const student = await Student.findById(created._id).populate('costumes').lean<StudentResponse>();
  sendResponse(res, 201, true, 'Tạo học sinh thành công', student);
};

export const update = async (req: Request, res: Response): Promise<void> => {
  if (await BookingWorkflow.exists({ 'members.student': req.params.id })) {
    sendResponse(
      res,
      409,
      false,
      'Students linked to a booking must be edited through the booking workflow',
    );
    return;
  }
  const student = await Student.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  })
    .populate('costumes')
    .lean<StudentResponse | null>();
  if (!student) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Cập nhật thành công', student);
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  if (await BookingWorkflow.exists({ 'members.student': req.params.id })) {
    sendResponse(
      res,
      409,
      false,
      'Students linked to a booking cannot be deleted through the legacy route',
    );
    return;
  }
  const student = await Student.findByIdAndDelete(req.params.id);
  if (!student) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Đã xóa học sinh');
};
