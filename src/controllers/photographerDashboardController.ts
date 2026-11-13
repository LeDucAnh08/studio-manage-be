import { Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import Workflow from '../models/BookingWorkflow';
import ConceptOrder from '../models/ConceptOrder';
import Season from '../models/Season';
import { photographerOrdersPipeline } from './photographerOrdersController';
import {
  dashboardMetrics,
  dashboardRange,
  photographerDashboard,
  vietnamDay,
  DashboardMetric,
  DashboardOrder,
  DashboardPeriod,
} from '../services/photographerDashboard';
import { conceptEnabled } from '../services/conceptPolicy';
import { WorkflowProblem } from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';

export async function getPhotographerStats(req: Request, res: Response) {
  const { period = 'month', service = '', season, metric, group = '0', page = '1' } = req.query;
  if (typeof period !== 'string' || !['month', 'previous', 'quarter', 'year'].includes(period))
    throw new WorkflowProblem(400, 'Kỳ thống kê không hợp lệ.');
  if (
    typeof service !== 'string' ||
    !['', 'concept', 'yearbook'].includes(service) ||
    (service === 'concept' && !conceptEnabled())
  )
    throw new WorkflowProblem(400, 'Loại dịch vụ không hợp lệ.');
  if (
    metric !== undefined &&
    (typeof metric !== 'string' || !(dashboardMetrics as readonly string[]).includes(metric))
  )
    throw new WorkflowProblem(400, 'Chỉ số thống kê không hợp lệ.');
  if (
    typeof page !== 'string' ||
    !/^\d+$/.test(page) ||
    +page < 1 ||
    +page > 100000 ||
    typeof group !== 'string' ||
    !/^[0-4]$/.test(group)
  )
    throw new WorkflowProblem(400, 'Thông tin phân trang không hợp lệ.');
  const now = Date.now(),
    range = dashboardRange(period as DashboardPeriod, now);
  const pipeline = photographerOrdersPipeline(req.user!._id, service, true);
  pipeline.push({
    $match: {
      $or: [
        { shootDate: { $gte: range.start, $lt: range.end } },
        { completedAt: { $gte: range.start, $lt: range.end } },
      ],
    },
  });
  if (season !== undefined) {
    if (typeof season !== 'string' || !isValidObjectId(season))
      throw new WorkflowProblem(400, 'Mùa chụp không hợp lệ.');
    const selected = await Season.findById(season).select('startDate endDate').lean();
    if (!selected) throw new WorkflowProblem(404, 'Không tìm thấy mùa chụp.');
    pipeline.push({
      $match: {
        shootDate: {
          $gte: new Date(vietnamDay(selected.startDate) + 'T00:00:00+07:00'),
          $lt: new Date(Date.parse(vietnamDay(selected.endDate) + 'T00:00:00+07:00') + 86400000),
        },
      },
    });
  }
  const rows: DashboardOrder[] = await (service === 'concept' ? ConceptOrder : Workflow).aggregate(
    pipeline,
  );
  sendResponse(
    res,
    200,
    true,
    'OK',
    photographerDashboard(
      rows,
      period as DashboardPeriod,
      now,
      metric as DashboardMetric | undefined,
      +group,
      +page,
    ),
  );
}
