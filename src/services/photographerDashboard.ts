import { bookingShootWindow } from './bookingOrderStage';

export const dashboardMetrics = [
  'shoots',
  'upcoming',
  'editing',
  'review',
  'completed',
  'overdue',
  'group',
] as const;
export type DashboardMetric = (typeof dashboardMetrics)[number];
export type DashboardPeriod = 'month' | 'previous' | 'quarter' | 'year';
export interface DashboardOrder {
  _id: string;
  service: 'concept' | 'yearbook';
  title: string;
  packageName: string;
  stage: string;
  role: 'lead' | 'support' | 'editor';
  shootDate: Date | string;
  startTime?: string;
  endTime?: string;
  shootWindow?: { startAt: string | Date; endAt: string | Date } | null;
  actualShoot: boolean;
  location?: string;
  deadline?: Date | string | null;
  completedAt?: Date | string | null;
  acceptedAt?: Date | string | null;
  albumStatus?: string;
}
export const vietnamDay = (value: Date | string | number | null | undefined) => {
  const date = value == null ? new Date(NaN) : new Date(value);
  return Number.isFinite(+date)
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date)
    : '';
};
export function dashboardRange(period: DashboardPeriod, now: number) {
  const [year, month] = vietnamDay(now).split('-').map(Number);
  const firstMonth =
    period === 'year'
      ? 0
      : period === 'quarter'
        ? Math.floor((month - 1) / 3) * 3
        : period === 'previous'
          ? month - 2
          : month - 1;
  const count = period === 'year' ? 12 : period === 'quarter' ? 3 : 1;
  const from = new Date(Date.UTC(year, firstMonth, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(year, firstMonth + count, 0)).toISOString().slice(0, 10);
  return {
    from,
    to,
    start: new Date(from + 'T00:00:00+07:00'),
    end: new Date(Date.parse(to + 'T00:00:00+07:00') + 86400000),
  };
}

export function photographerDashboard(
  rows: DashboardOrder[],
  period: DashboardPeriod,
  now: number,
  metric?: DashboardMetric,
  group = 0,
  page = 1,
) {
  const range = dashboardRange(period, now),
    today = vietnamDay(now);
  const within = (value: Date | string | null | undefined) => {
    const day = vietnamDay(value);
    return !!day && day >= range.from && day <= range.to;
  };
  const active = rows.filter((row) => !['cancelled', 'rejected'].includes(row.stage));
  const pool = active.filter((row) => within(row.shootDate));
  const windows = new Map(
    active.map((row) => [
      row.service + ':' + row._id,
      row.service === 'yearbook' ? bookingShootWindow(row) : row.shootWindow,
    ]),
  );
  const windowFor = (row: DashboardOrder) => windows.get(row.service + ':' + row._id);
  const isReview = (row: DashboardOrder) =>
    row.service === 'concept'
      ? row.albumStatus === 'delivered'
      : row.stage === 'delivered' && !row.acceptedAt;
  const editing = pool.filter((row) => row.stage === 'editing' && !isReview(row));
  const shoots = pool.filter(
    (row) =>
      row.actualShoot &&
      row.role !== 'editor' &&
      !['pending', 'awaiting_confirmation'].includes(row.stage),
  );
  const upcoming = shoots.filter((row) => {
    const start = Date.parse(String(windowFor(row)?.startAt || ''));
    return (
      start >= now && start < now + 7 * 86400000 && ['confirmed', 'active'].includes(row.stage)
    );
  });
  const overdue = editing.filter((row) => {
    const day = vietnamDay(row.deadline);
    return day && day < today;
  });
  const sets = {
    shoots,
    upcoming,
    editing,
    review: pool.filter(isReview),
    completed: active.filter((row) => row.stage === 'completed' && within(row.completedAt)),
    overdue,
  };
  const bucketCount =
    period === 'year' ? 4 : period === 'quarter' ? 3 : Math.ceil(Number(range.to.slice(8)) / 7);
  const chart = Array.from({ length: bucketCount }, (_, index) => ({
    key: String(index),
    label:
      period === 'year'
        ? `Quý ${index + 1}`
        : period === 'quarter'
          ? `Tháng ${Number(range.from.slice(5, 7)) + index}`
          : `${index * 7 + 1}–${Math.min(index * 7 + 7, Number(range.to.slice(8)))}`,
    concept: 0,
    yearbook: 0,
  }));
  const groupOf = (row: DashboardOrder) => {
    const day = vietnamDay(row.shootDate);
    return period === 'year'
      ? Math.floor((Number(day.slice(5, 7)) - 1) / 3)
      : period === 'quarter'
        ? Number(day.slice(5, 7)) - Number(range.from.slice(5, 7))
        : Math.floor((Number(day.slice(8)) - 1) / 7);
  };
  shoots.forEach((row) => {
    chart[groupOf(row)][row.service]++;
  });
  const publicRow = (row: DashboardOrder) => ({
    _id: row._id,
    service: row.service,
    title: row.title || row.packageName,
    packageName: row.packageName,
    stage: row.stage,
    role: row.role,
    shootDate: row.shootDate,
    startTime: row.startTime,
    endTime: row.endTime,
    deadline: row.deadline || null,
    location: row.location || '',
    shootWindow: windowFor(row) || null,
  });
  const priority = [...editing].sort(
    (a, b) =>
      (vietnamDay(a.deadline) || '9999').localeCompare(vietnamDay(b.deadline) || '9999') ||
      a._id.localeCompare(b._id),
  );
  const selected =
    metric === 'group'
      ? shoots.filter((row) => groupOf(row) === group)
      : metric
        ? sets[metric]
        : [];
  const sorted =
    metric === 'overdue' || metric === 'editing'
      ? [...selected].sort(
          (a, b) =>
            (vietnamDay(a.deadline) || '9999').localeCompare(vietnamDay(b.deadline) || '9999') ||
            a._id.localeCompare(b._id),
        )
      : [...selected].sort(
          (a, b) =>
            Date.parse(String(a.shootDate)) - Date.parse(String(b.shootDate)) ||
            (a.startTime || '').localeCompare(b.startTime || '') ||
            a._id.localeCompare(b._id),
        );
  const midnight = Date.parse(today + 'T00:00:00+07:00') + 86400000;
  const changes = active
    .flatMap((row) => {
      const window = windowFor(row);
      return [
        Date.parse(String(window?.startAt || '')),
        Date.parse(String(window?.endAt || '')),
        Date.parse(String(window?.startAt || '')) - 7 * 86400000 + 1,
      ];
    })
    .filter((time) => time > now);
  return {
    from: range.from,
    to: range.to,
    now: new Date(now).toISOString(),
    nextRefreshAt: new Date(Math.min(midnight, ...changes)).toISOString(),
    counts: Object.fromEntries(Object.entries(sets).map(([key, value]) => [key, value.length])),
    breakdown: {
      concept: shoots.filter((row) => row.service === 'concept').length,
      yearbook: shoots.filter((row) => row.service === 'yearbook').length,
    },
    chart,
    priority: priority.slice(0, 3).map(publicRow),
    ...(metric
      ? {
          detail: {
            rows: sorted.slice((page - 1) * 20, page * 20).map(publicRow),
            total: selected.length,
            page,
            limit: 20,
          },
        }
      : {}),
  };
}
