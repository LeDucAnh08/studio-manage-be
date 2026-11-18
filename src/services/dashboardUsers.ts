import User from '../models/User';

const VN_OFFSET = 7 * 3600000;
export function dashboardUserPeriods(now: Date) {
  const local = new Date(now.getTime() + VN_OFFSET);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const start = (offset: number) => new Date(Date.UTC(year, month + offset, 1) - VN_OFFSET);
  const currentStart = start(0);
  const previousStart = start(-1);
  // Compare the same elapsed duration, capped at the shorter previous month's end.
  const previousEnd = new Date(
    Math.min(
      currentStart.getTime(),
      previousStart.getTime() + now.getTime() - currentStart.getTime(),
    ),
  );
  const months = Array.from({ length: 6 }, (_, i) =>
    new Date(start(i - 5).getTime() + VN_OFFSET).toISOString().slice(0, 7),
  );
  return { currentStart, previousStart, previousEnd, seriesStart: start(-5), months };
}

export async function dashboardUsers(now: Date) {
  const period = dashboardUserPeriods(now);
  const [total, current, previous, rows] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: period.currentStart, $lte: now } }),
    User.countDocuments({ createdAt: { $gte: period.previousStart, $lt: period.previousEnd } }),
    User.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: period.seriesStart, $lte: now } } },
      {
        $group: {
          _id: {
            $dateToString: { date: '$createdAt', format: '%Y-%m', timezone: 'Asia/Ho_Chi_Minh' },
          },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);
  return {
    asOf: now.toISOString(),
    total,
    current,
    previous,
    difference: current - previous,
    percent: previous ? Math.round(((current - previous) / previous) * 1000) / 10 : null,
    currentFrom: period.currentStart.toISOString(),
    previousFrom: period.previousStart.toISOString(),
    previousTo: period.previousEnd.toISOString(),
    monthly: period.months.map((label) => ({
      label,
      count: rows.find((row) => row._id === label)?.count ?? 0,
    })),
  };
}
