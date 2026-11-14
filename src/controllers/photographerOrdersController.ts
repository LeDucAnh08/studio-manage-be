import { Request, Response } from 'express';
import { PipelineStage, Types } from 'mongoose';
import Workflow from '../models/BookingWorkflow';
import Booking from '../models/Booking';
import Schedule from '../models/Schedule';
import ConceptOrder from '../models/ConceptOrder';
import ConceptAlbum from '../models/ConceptAlbum';
import {
  bookingOrderStageExpression,
  bookingOrderStages,
  bookingShootWindow,
} from '../services/bookingOrderStage';
import { conceptEnabled } from '../services/conceptPolicy';
import { WorkflowProblem } from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';

export const conceptShootStageExpression = {
  $switch: {
    branches: [
      { case: { $in: ['$status', ['cancelled', 'expired']] }, then: 'cancelled' },
      { case: { $eq: ['$status', 'completed'] }, then: 'completed' },
      { case: { $eq: ['$status', 'shot'] }, then: 'editing' },
      {
        case: { $eq: ['$status', 'confirmed'] },
        then: {
          $cond: [
            { $lt: ['$$NOW', '$startAt'] },
            'confirmed',
            { $cond: [{ $lt: ['$$NOW', '$endAt'] }, 'active', 'editing'] },
          ],
        },
      },
    ],
    default: 'awaiting_confirmation',
  },
};

// Shared caller scope for the photographer list and its statistics.
export function photographerOrdersPipeline(
  actor: Types.ObjectId,
  service: string,
  dashboard = false,
): PipelineStage[] {
  const yearbooks: PipelineStage[] = [
    {
      $match: {
        $or: [
          { assignedPhotographer: actor },
          { assignedSupportPhotographers: actor },
          { 'resources.photographers': actor },
        ],
      },
    },
    {
      $lookup: {
        from: Booking.collection.name,
        localField: 'booking',
        foreignField: '_id',
        as: '__booking',
      },
    },
    { $unwind: '$__booking' },
    {
      $lookup: {
        from: Schedule.collection.name,
        localField: 'resources.schedule',
        foreignField: '_id',
        as: '__schedules',
      },
    },
    {
      $set: {
        __schedule: { $arrayElemAt: ['$__schedules', 0] },
        __workflow: {
          lifecycle: '$lifecycle',
          changeRequest: '$changeRequest',
          resources: '$resources',
        },
        status: '$__booking.status',
      },
    },
    {
      $project: {
        _id: { $toString: '$__booking._id' },
        service: { $literal: 'yearbook' },
        title: { $ifNull: ['$__booking.className', '$__booking.packageName'] },
        packageName: '$__booking.packageName',
        stage: bookingOrderStageExpression,
        shootDate: { $ifNull: ['$__schedule.shootDate', '$__booking.startAt'] },
        startTime: '$__schedule.startTime',
        endTime: '$__schedule.endTime',
        shootWindow: { $literal: null },
        updatedAt: { $ifNull: ['$updatedAt', '$__booking.updatedAt'] },
        role: {
          $cond: [
            {
              $eq: [
                {
                  $ifNull: [
                    '$assignedPhotographer',
                    { $arrayElemAt: ['$resources.photographers', 0] },
                  ],
                },
                actor,
              ],
            },
            'lead',
            'support',
          ],
        },
        ...(dashboard
          ? {
              actualShoot: {
                $and: [
                  { $ne: [{ $ifNull: ['$__schedule._id', null] }, null] },
                  { $in: ['$__schedule.status', ['confirmed', 'completed']] },
                ],
              },
              location: '$__schedule.location',
              deadline: '$quote.delivery.targetDate',
              acceptedAt: '$progress.acceptedAt',
              seasonId: '$__booking.season',
              completedAt: {
                $max: {
                  $map: {
                    input: {
                      $filter: {
                        input: { $ifNull: ['$events', []] },
                        as: 'event',
                        cond: { $eq: ['$$event.action', 'workflow.completed'] },
                      },
                    },
                    as: 'event',
                    in: '$$event.at',
                  },
                },
              },
            }
          : {}),
      },
    },
  ];
  const albums: Exclude<PipelineStage, PipelineStage.Merge | PipelineStage.Out>[] = [
    {
      $lookup: {
        from: ConceptAlbum.collection.name,
        localField: '_id',
        foreignField: 'order',
        as: '__albums',
      },
    },
    { $set: { __album: { $arrayElemAt: ['$__albums', 0] } } },
  ];
  const concepts: Exclude<PipelineStage, PipelineStage.Merge | PipelineStage.Out>[] = [
    { $match: { $or: [{ photographer: actor }, { editor: actor }] } },
    ...(dashboard ? albums : []),
    {
      $project: {
        _id: { $toString: '$_id' },
        service: { $literal: 'concept' },
        title: '$snapshot.conceptName',
        packageName: '$snapshot.name',
        stage: conceptShootStageExpression,
        shootDate: '$startAt',
        startTime: {
          $dateToString: { date: '$startAt', format: '%H:%M', timezone: 'Asia/Ho_Chi_Minh' },
        },
        endTime: {
          $dateToString: { date: '$endAt', format: '%H:%M', timezone: 'Asia/Ho_Chi_Minh' },
        },
        shootWindow: { startAt: '$startAt', endAt: '$endAt' },
        updatedAt: 1,
        role: { $cond: [{ $eq: ['$photographer', actor] }, 'lead', 'editor'] },
        ...(dashboard
          ? {
              actualShoot: {
                $and: [
                  { $eq: ['$photographer', actor] },
                  { $in: ['$status', ['confirmed', 'shot', 'completed']] },
                ],
              },
              location: { $literal: 'Studio' },
              deadline: { $literal: null },
              albumStatus: '$__album.status',
              completedAt: {
                $max: {
                  $map: {
                    input: {
                      $filter: {
                        input: { $ifNull: ['$events', []] },
                        as: 'event',
                        cond: { $eq: ['$$event.action', 'album.accept'] },
                      },
                    },
                    as: 'event',
                    in: '$$event.at',
                  },
                },
              },
            }
          : {}),
      },
    },
  ];
  const pipeline: PipelineStage[] = service === 'concept' ? [...concepts] : [...yearbooks];
  if (!service && conceptEnabled())
    pipeline.push({ $unionWith: { coll: ConceptOrder.collection.name, pipeline: concepts } });
  return pipeline;
}

// A single sorted, paginated feed. Both branches are scoped before joining or counting.
export async function listPhotographerOrders(req: Request, res: Response) {
  const { service = '', stage = '', page = '1', limit = '20' } = req.query;
  if (typeof service !== 'string' || !['', 'concept', 'yearbook'].includes(service))
    throw new WorkflowProblem(400, 'Loại dịch vụ không hợp lệ.');
  if (typeof stage !== 'string' || (stage && !bookingOrderStages.includes(stage)))
    throw new WorkflowProblem(400, 'Trạng thái đơn không hợp lệ.');
  if (
    typeof page !== 'string' ||
    typeof limit !== 'string' ||
    !/^\d+$/.test(page) ||
    !/^\d+$/.test(limit) ||
    Number(page) < 1 ||
    Number(page) > 100000 ||
    Number(limit) < 1 ||
    Number(limit) > 50
  )
    throw new WorkflowProblem(400, 'Thông tin phân trang không hợp lệ.');
  if (service === 'concept' && !conceptEnabled())
    throw new WorkflowProblem(400, 'Dịch vụ concept chưa được bật.');
  const pipeline = photographerOrdersPipeline(req.user!._id, service);
  if (stage) pipeline.push({ $match: { stage } });
  pipeline.push({
    $facet: {
      data: [
        { $sort: { updatedAt: -1, service: 1, _id: -1 } },
        { $skip: (Number(page) - 1) * Number(limit) },
        { $limit: Number(limit) },
      ],
      count: [{ $count: 'total' }],
    },
  });
  const [result] = await (service === 'concept' ? ConceptOrder : Workflow).aggregate(pipeline);
  // Reuse the confirmed schedule window parser for yearbook refreshes at time boundaries.
  const data = result.data.map((row: any) => ({
    ...row,
    shootWindow:
      row.service === 'yearbook' && row.startTime && row.endTime
        ? bookingShootWindow(row)
        : row.shootWindow,
  }));
  sendResponse(res, 200, true, 'OK', data, {
    total: result.count[0]?.total ?? 0,
    page: Number(page),
    limit: Number(limit),
  });
}
