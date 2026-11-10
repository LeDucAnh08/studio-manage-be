// Public stages group internal workflow states without changing action permissions.
export const rentalStageStatuses = {
  awaiting_confirmation: [
    'requested',
    'quoting',
    'awaiting_deposit',
    'ready_to_confirm',
    'payment_review',
  ],
  ready_for_pickup: ['confirmed'],
  renting: ['checked_out'],
  settling: ['returned'],
  completed: ['completed'],
  cancelled: ['cancelled', 'rejected', 'expired'],
} as const;

export type RentalStage = keyof typeof rentalStageStatuses;

export const getRentalStage = (status: string): RentalStage => {
  const entry = Object.entries(rentalStageStatuses).find(([, statuses]) =>
    (statuses as readonly string[]).includes(status),
  );
  return (entry?.[0] as RentalStage | undefined) ?? 'awaiting_confirmation';
};

export const rentalViewStatuses = (view: string): readonly string[] | undefined => {
  if (Object.prototype.hasOwnProperty.call(rentalStageStatuses, view))
    return rentalStageStatuses[view as RentalStage];
  // Retain old API links; new interfaces only use the canonical stages above.
  if (view === 'active')
    return Object.entries(rentalStageStatuses)
      .filter(([stage]) => !['completed', 'cancelled'].includes(stage))
      .flatMap(([, statuses]) => [...statuses]);
  if (['rejected', 'expired', 'payment_review'].includes(view)) return [view];
  return undefined;
};
