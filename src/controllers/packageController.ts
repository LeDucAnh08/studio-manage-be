import { Request, Response } from 'express';
import Package from '../models/Package';
import { sendResponse } from '../utils/response';
import { deletePackageImages } from '../services/packageMedia';

export const getAll = async (_req: Request, res: Response): Promise<void> => {
  const packages = await Package.find()
    .select('-details')
    .sort({ name: 1 })
    .populate('costumes')
    .lean();
  sendResponse(res, 200, true, 'OK', packages);
};

export const getOne = async (req: Request, res: Response): Promise<void> => {
  const pkg = await Package.findById(req.params.id).populate('costumes').lean();
  if (!pkg) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'OK', pkg);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const data = { ...req.body };
  delete data.details;
  delete data.detailsVersion;
  const pkg = await Package.create(data);
  sendResponse(res, 201, true, 'Tạo gói chụp thành công', pkg);
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const data = { ...req.body };
  delete data.details;
  delete data.detailsVersion;
  // Content and managed media can only be changed through the validated content endpoint.
  if (Object.keys(data).some((key) => key.startsWith('$') || key.includes('.'))) {
    sendResponse(res, 400, false, 'Trường cập nhật không hợp lệ.');
    return;
  }
  const pkg = await Package.findByIdAndUpdate(
    req.params.id,
    { $set: data },
    {
      new: true,
      runValidators: true,
    },
  );
  if (!pkg) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Cập nhật thành công', pkg);
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const pkg = await Package.findByIdAndDelete(req.params.id);
  if (pkg?.details) await deletePackageImages(pkg.details.gallery.map((image) => image.id));
  sendResponse(res, 200, true, 'Đã xóa gói chụp');
};
