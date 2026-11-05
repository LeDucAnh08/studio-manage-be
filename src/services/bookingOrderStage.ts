// Public order stages group workflow steps without changing business transitions.
export const bookingStageLifecycles = {
  awaiting_confirmation: ['intake', 'quoting', 'awaiting_deposit', 'ready_to_confirm'],
  confirmed: ['confirmed'],
  active: ['shooting', 'editing', 'revision_requested'],
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

export function bookingOrderStage(status: string, workflow?: StageWorkflow | null): string {
  if (status === 'rejected') return 'rejected';
  if (status === 'cancelled' || workflow?.lifecycle === 'cancelled') return 'cancelled';
  if (status === 'pending') return 'pending';
  const lifecycle =
    workflow?.lifecycle === 'change_pending'
      ? (workflow.changeRequest?.previousLifecycle ??
        (workflow.resources?.schedule ? 'confirmed' : 'intake'))
      : workflow?.lifecycle || 'intake';
  return (
    Object.entries(bookingStageLifecycles).find(([, steps]) =>
      (steps as readonly string[]).includes(lifecycle),
    )?.[0] || 'awaiting_confirmation'
  );
}

// Used after looking up a booking's workflow as __workflow, before pagination.
export const bookingOrderStageExpression = {
  $let: {
    vars: {
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
