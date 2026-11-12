import { scheduleInterval } from './photographerAvailability';

// Public order stages group workflow steps without changing business transitions.
export const bookingStageLifecycles = {
  awaiting_confirmation: ['intake', 'quoting', 'awaiting_deposit', 'ready_to_confirm'],
  confirmed: ['confirmed'],
  active: ['shooting'],
  editing: ['editing', 'revision_requested'],
  delivered: ['delivered', 'accepted'],
  completed: ['completed'],
} as const;

export const bookingOrderStages = [
  'pending',
  ...Object.keys(bookingStageLifecycles),
  'cancelled',
  'rejected',
];

type StageWorkflow = {
  lifecycle?: string;
  changeRequest?: { previousLifecycle?: string } | null;
  resources?: { schedule?: unknown } | null;
};

type ShootSchedule = { shootDate: Date | string; startTime?: string; endTime?: string };

export function bookingShootWindow(schedule?: ShootSchedule | null) {
  const interval = schedule && scheduleInterval(schedule);
  return interval
    ? {
        startAt: new Date(interval.start).toISOString(),
        endAt: new Date(interval.end).toISOString(),
      }
    : null;
}

export function bookingOrderStage(
  status: string,
  workflow?: StageWorkflow | null,
  schedule?: ShootSchedule | null,
  now = Date.now(),
): string {
  if (status === 'rejected') return 'rejected';
  if (status === 'cancelled' || workflow?.lifecycle === 'cancelled') return 'cancelled';
  if (status === 'pending') return 'pending';
  const lifecycle =
    workflow?.lifecycle === 'change_pending'
      ? (workflow.changeRequest?.previousLifecycle ??
        (workflow.resources?.schedule ? 'confirmed' : 'intake'))
      : workflow?.lifecycle || 'intake';
  if (['confirmed', 'shooting', 'editing', 'revision_requested'].includes(lifecycle)) {
    const interval = schedule && scheduleInterval(schedule);
    if (interval) {
      if (now < interval.start) return 'confirmed';
      return now < interval.end ? 'active' : 'editing';
    }
    // An unverified or missing schedule must never advertise an ongoing shoot.
    return ['editing', 'revision_requested'].includes(lifecycle) ? 'editing' : 'confirmed';
  }
  return (
    Object.entries(bookingStageLifecycles).find(([, steps]) =>
      (steps as readonly string[]).includes(lifecycle),
    )?.[0] || 'awaiting_confirmation'
  );
}

// Used after looking up __workflow and its actual __schedule, before pagination.
const scheduleTimestamp = (field: string) => ({
  $dateFromString: {
    dateString: {
      $concat: [
        {
          $dateToString: {
            date: '$__schedule.shootDate',
            format: '%Y-%m-%d',
            timezone: 'Asia/Ho_Chi_Minh',
            onNull: null,
          },
        },
        'T',
        {
          $cond: [
            {
              $regexMatch: {
                input: { $ifNull: [`$__schedule.${field}`, ''] },
                regex: /^([01]\d|2[0-3]):[0-5]\d$/,
              },
            },
            `$__schedule.${field}`,
            null,
          ],
        },
        ':00',
      ],
    },
    timezone: 'Asia/Ho_Chi_Minh',
    onError: null,
    onNull: null,
  },
});

export const bookingOrderStageExpression = {
  $let: {
    vars: {
      start: scheduleTimestamp('startTime'),
      end: scheduleTimestamp('endTime'),
      lifecycle: {
        $cond: [
          { $eq: ['$__workflow.lifecycle', 'change_pending'] },
          {
            $ifNull: [
              '$__workflow.changeRequest.previousLifecycle',
              {
                $cond: [
                  { $ifNull: ['$__workflow.resources.schedule', false] },
                  'confirmed',
                  'intake',
                ],
              },
            ],
          },
          { $ifNull: ['$__workflow.lifecycle', 'intake'] },
        ],
      },
    },
    in: {
      $switch: {
        branches: [
          { case: { $eq: ['$status', 'rejected'] }, then: 'rejected' },
          {
            case: {
              $or: [
                { $eq: ['$status', 'cancelled'] },
                { $eq: ['$__workflow.lifecycle', 'cancelled'] },
              ],
            },
            then: 'cancelled',
          },
          { case: { $eq: ['$status', 'pending'] }, then: 'pending' },
          {
            case: {
              $in: ['$$lifecycle', ['confirmed', 'shooting', 'editing', 'revision_requested']],
            },
            then: {
              $cond: [
                { $and: [{ $ne: ['$$start', null] }, { $gt: ['$$end', '$$start'] }] },
                {
                  $cond: [
                    { $lt: ['$$NOW', '$$start'] },
                    'confirmed',
                    { $cond: [{ $lt: ['$$NOW', '$$end'] }, 'active', 'editing'] },
                  ],
                },
                {
                  $cond: [
                    { $in: ['$$lifecycle', ['editing', 'revision_requested']] },
                    'editing',
                    'confirmed',
                  ],
                },
              ],
            },
          },
          ...Object.entries(bookingStageLifecycles).map(([stage, steps]) => ({
            case: { $in: ['$$lifecycle', steps] },
            then: stage,
          })),
        ],
        default: 'awaiting_confirmation',
      },
    },
  },
};
