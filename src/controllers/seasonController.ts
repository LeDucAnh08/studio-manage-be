import { Request, Response } from 'express';
import Season from '../models/Season';
import { clearSeasonCache } from '../utils/seasonCache';
import { sendResponse } from '../utils/response';

export const getAll = async (_req: Request, res: Response): Promise<void> => {
  const seasons = await Season.find();
  sendResponse(res, 200, true, 'OK', seasons);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const { name, startDate, endDate } = req.body;
  if (!name || !startDate || !endDate) {
    sendResponse(res, 400, false, 'Missing required fields');
    return;
  }
  const season = new Season({ name, startDate, endDate });
  await season.save();
  clearSeasonCache();
  sendResponse(res, 201, true, 'Tạo mùa chụp thành công', season);
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { name, startDate, endDate } = req.body;
  const season = await Season.findByIdAndUpdate(
    id,
    { name, startDate, endDate },
    { new: true, runValidators: true },
  );
  if (!season) {
    sendResponse(res, 404, false, 'Season not found');
    return;
  }
  clearSeasonCache();
  sendResponse(res, 200, true, 'Cập nhật thành công', season);
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const season = await Season.findByIdAndDelete(id);
  if (!season) {
    sendResponse(res, 404, false, 'Season not found');
    return;
  }
  clearSeasonCache();
  sendResponse(res, 200, true, 'Đã xóa mùa chụp');
};
