import { Request, Response } from 'express';
import Workflow from '../models/BookingWorkflow';
import ConceptOrder from '../models/ConceptOrder';
import { photographerOrdersPipeline } from './photographerOrdersController';
import {
  dashboardMetrics,
  dashboardRange,
  photographerDashboard,
  DashboardMetric,
  DashboardOrder,
  DashboardPeriod,
} from '../services/photographerDashboard';
import { WorkflowProblem } from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';

export async function getPhotographerStats(req: Request, res: Response) {
  const { period = 'month', service = '', metric, group = '0', page = '1' } = req.query;
  if (typeof period !== 'string' || !['month', 'previous', 'quarter', 'year'].includes(period))
    throw new WorkflowProblem(400, 'Kỳ thống kê không hợp lệ.');
  if (typeof service !== 'string' || !['', 'concept', 'yearbook'].includes(service))
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
