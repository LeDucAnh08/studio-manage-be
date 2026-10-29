import { ClientSession } from 'mongoose';
import Schedule from '../models/Schedule';
import User from '../models/User';

export const workflowPhotographers = async (workflows: any[], session?: ClientSession) => {
  const legacy = workflows.filter(
    (row) =>
      (!row.assignedPhotographer || row.assignedSupportPhotographers === undefined) &&
      row.resources?.schedule,
  );
  const schedules = await Schedule.find({
    _id: { $in: legacy.map((row) => row.resources.schedule) },
  })
    .select('leadPhotographer supportPhotographers')
    .session(session ?? null)
    .lean();
  const bySchedule = new Map(schedules.map((row) => [String(row._id), row]));
  const assignmentIds = new Map<string, { lead: unknown; supports: unknown[] }>(
    workflows.map((row) => [
      String(row.booking),
      {
        lead:
          row.assignedPhotographer ??
          bySchedule.get(String(row.resources?.schedule))?.leadPhotographer,
        supports:
          row.assignedSupportPhotographers ??
          bySchedule.get(String(row.resources?.schedule))?.supportPhotographers ??
          [],
      },
    ]),
  );
  const users = await User.find({
    _id: {
      $in: [...assignmentIds.values()]
        .flatMap((team) => [team.lead, ...team.supports])
        .filter(Boolean),
    },
  })
    .select('_id name username')
    .session(session ?? null)
    .lean();
  const byId = new Map(
    users.map((row) => [String(row._id), { _id: String(row._id), name: row.name || row.username }]),
  );
  return new Map(
    [...assignmentIds].map(([booking, team]) => [
      booking,
      {
        assignedPhotographer: byId.get(String(team.lead)) ?? null,
        assignedSupportPhotographers: team.supports
          .filter((id: unknown) => String(id) !== String(team.lead))
          .map((id: unknown) => byId.get(String(id)))
          .filter(
            (
              person: { _id: string; name: string } | undefined,
            ): person is { _id: string; name: string } => !!person,
          ),
      },
    ]),
  );
};
