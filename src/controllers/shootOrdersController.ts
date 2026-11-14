import { Request, Response } from 'express';
import type { PipelineStage } from 'mongoose';
import Booking from '../models/Booking';
import Workflow from '../models/BookingWorkflow';
import Schedule from '../models/Schedule';
import ConceptOrder from '../models/ConceptOrder';
import User from '../models/User';
import { bookingOrderStageExpression, bookingOrderStages } from '../services/bookingOrderStage';
import { conceptEnabled } from '../services/conceptPolicy';
import { expirePendingBookings } from '../services/bookingExpiry';
import { expireConceptOrders, netReceived } from '../services/conceptBooking';
import { WorkflowProblem } from '../services/workflowTransactions';
import { sendResponse } from '../utils/response';
import { workflowListRows } from './workflowController';
import { conceptShootStageExpression } from './photographerOrdersController';

export function shootOrdersScope(actor: NonNullable<Request['user']>) {
  const has = (role: number) => actor.roles.includes(role as never);
  const admin = has(0) || has(1);
  const personal = has(3) && ![0, 1, 2, 4].some(has);
  return {
    yearbook: admin || has(5) || has(3),
    yearbookAll: !personal && (admin || has(5)),
    concept: admin || has(2) || has(5) || has(3),
    conceptAll: !personal && (admin || has(2) || has(5)),
    finance: !personal && (admin || has(5)),
  };
}

export async function listShootOrders(req: Request, res: Response) {
  try {
    const actor = req.user!;
    const scope = shootOrdersScope(actor);
    const { service = '', stage = '', page = '1', limit = '20' } = req.query;
    if (
      typeof service !== 'string' ||
      !['', 'yearbook', 'concept'].includes(service) ||
      typeof stage !== 'string' ||
      (stage && !bookingOrderStages.includes(stage))
    )
      throw new WorkflowProblem(400, 'Bộ lọc đơn chụp không hợp lệ.');
    if (
      typeof page !== 'string' ||
      typeof limit !== 'string' ||
      !/^\d+$/.test(page) ||
      !/^\d+$/.test(limit) ||
      +page < 1 ||
      +page > 100000 ||
      +limit < 1 ||
      +limit > 50
    )
      throw new WorkflowProblem(400, 'Thông tin phân trang không hợp lệ.');
    if (
      (!scope.yearbook && !scope.concept) ||
      (service === 'yearbook' && !scope.yearbook) ||
      (service === 'concept' && !scope.concept)
    )
      throw new WorkflowProblem(403, 'Không có quyền xem loại đơn này.');
    if (service === 'concept' && !conceptEnabled())
      throw new WorkflowProblem(400, 'Dịch vụ concept chưa được bật.');
    const includeYearbook = scope.yearbook && service !== 'concept';
    const includeConcept = scope.concept && conceptEnabled() && service !== 'yearbook';
    if (includeYearbook) await expirePendingBookings();
    if (includeConcept) await expireConceptOrders();
    const yearbooks: PipelineStage[] = [
      {
        $lookup: {
          from: Workflow.collection.name,
          localField: '_id',
          foreignField: 'booking',
          as: '__workflows',
        },
      },
      { $set: { __workflow: { $arrayElemAt: ['$__workflows', 0] } } },
      ...(!scope.yearbookAll
        ? [
            {
              $match: {
                $or: [
                  { '__workflow.assignedPhotographer': actor._id },
                  { '__workflow.assignedSupportPhotographers': actor._id },
                  { '__workflow.resources.photographers': actor._id },
                ],
              },
            },
          ]
        : []),
      {
        $lookup: {
          from: Schedule.collection.name,
          localField: '__workflow.resources.schedule',
          foreignField: '_id',
          as: '__schedules',
        },
      },
      { $set: { __schedule: { $arrayElemAt: ['$__schedules', 0] } } },
      {
        $set: {
          service: { $literal: 'yearbook' },
          orderStage: bookingOrderStageExpression,
          updatedAt: { $ifNull: ['$__workflow.updatedAt', '$updatedAt'] },
        },
      },
      { $unset: ['__workflows', '__workflow', '__schedules', '__schedule'] },
    ];
    const concepts: Exclude<PipelineStage, PipelineStage.Out | PipelineStage.Merge>[] = [
      {
        $match: scope.conceptAll
          ? {}
          : { $or: [{ photographer: actor._id }, { editor: actor._id }] },
      },
      { $set: { service: { $literal: 'concept' }, orderStage: conceptShootStageExpression } },
    ];
    const pipeline: PipelineStage[] = includeYearbook
      ? yearbooks
      : includeConcept
        ? concepts
        : [{ $match: { _id: { $exists: false } } }];
    if (includeYearbook && includeConcept)
      pipeline.push({ $unionWith: { coll: ConceptOrder.collection.name, pipeline: concepts } });
    if (stage) pipeline.push({ $match: { orderStage: stage } });
    pipeline.push({
      $facet: {
        data: [
          { $sort: { updatedAt: -1, service: 1, _id: -1 } },
          { $skip: (+page - 1) * +limit },
          { $limit: +limit },
        ],
        count: [{ $count: 'total' }],
      },
    });
    const [result] = await (includeYearbook ? Booking : ConceptOrder).aggregate(pipeline);
    const rows: any[] = result?.data || [];
    const yearbookRows = await workflowListRows(
      rows.filter((row) => row.service === 'yearbook'),
      actor,
    );
    const byBooking = new Map(yearbookRows.map((row) => [row.bookingId, row]));
    const conceptRows = rows.filter((row) => row.service === 'concept');
    const people = await User.find({
      _id: { $in: conceptRows.flatMap((row) => [row.photographer, row.editor]).filter(Boolean) },
    })
      .select('_id name username')
      .lean();
    const byPerson = new Map(
      people.map((person) => [
        String(person._id),
        { _id: String(person._id), name: person.name || person.username },
      ]),
    );
    const data = rows.map((row) => {
      if (row.service === 'yearbook') {
        const value = { ...byBooking.get(String(row._id)), service: 'yearbook' };
        if (!scope.finance) delete value.payment;
        return value;
      }
      const cancelled = ['cancelled', 'expired'].includes(row.status);
      return {
        service: 'concept',
        bookingId: String(row._id),
        version: row.version,
        className: row.contactName,
        packageName: row.snapshot.name,
        conceptName: row.snapshot.conceptName,
        orderStage: row.orderStage,
        bookingStatus: cancelled ? 'cancelled' : 'approved',
        lifecycle: cancelled ? 'cancelled' : row.status === 'shot' ? 'editing' : row.status,
        shootWindow: { startAt: row.startAt, endAt: row.endAt },
        shootDate: row.startAt,
        startTime: new Date(row.startAt).toLocaleTimeString('en-GB', {
          timeZone: 'Asia/Ho_Chi_Minh',
          hour: '2-digit',
          minute: '2-digit',
        }),
        updatedAt: row.updatedAt,
        assignedPhotographer: byPerson.get(String(row.photographer)) || null,
        assignedSupportPhotographers:
          row.editor &&
          String(row.editor) !== String(row.photographer) &&
          byPerson.has(String(row.editor))
            ? [byPerson.get(String(row.editor))]
            : [],
        ...(scope.finance
          ? {
              conceptNetReceived: netReceived({ payments: row.payments || [] }),
              refundDue: row.refundDue,
            }
          : {}),
      };
    });
    sendResponse(res, 200, true, 'OK', data, {
      total: result?.count?.[0]?.total || 0,
      page: +page,
      limit: +limit,
    });
  } catch (error) {
    if (error instanceof WorkflowProblem) {
      sendResponse(res, error.status, false, error.message);
      return;
    }
    throw error;
  }
}
