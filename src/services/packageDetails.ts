import Package from '../models/Package';
import PackageDetail, { PACKAGE_DETAIL_FIELDS } from '../models/PackageDetail';
import type { PackageDetails } from '../types/packageContent';
import { withResourceTransaction, WorkflowProblem } from './workflowTransactions';

export function packageDetailContent(record: Record<string, any>): PackageDetails {
  return Object.fromEntries(
    PACKAGE_DETAIL_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(record, key)).map(
      (key) => [key, record[key]],
    ),
  ) as unknown as PackageDetails;
}

/** Preserve the existing API shape without reading any legacy embedded content. */
export async function attachPackageDetails(
  pkg: any,
): Promise<Record<string, any> & { details?: PackageDetails; detailsVersion?: number }> {
  const data = typeof pkg.toObject === 'function' ? pkg.toObject() : { ...pkg };
  if (Object.prototype.hasOwnProperty.call(data, 'details'))
    throw new WorkflowProblem(
      409,
      'Nội dung gói đang được chuyển dữ liệu. Hãy tải lại trước khi tiếp tục.',
    );
  const record = await PackageDetail.findOne({ package: data._id }).lean();
  if ((record?.version ?? 0) !== (data.detailsVersion ?? 0) || (!record && data.detailsVersion))
    throw new WorkflowProblem(409, 'Nội dung gói đang thay đổi. Hãy tải lại trước khi tiếp tục.');
  return { ...data, details: record ? packageDetailContent(record) : undefined };
}

/** Version gate and content commit together, so readers cannot accept mixed revisions. */
export async function savePackageDetails(
  id: unknown,
  version: number,
  details: PackageDetails,
): Promise<Record<string, any> & { details: PackageDetails; detailsVersion?: number }> {
  return withResourceTransaction(async (session) => {
    const current = await PackageDetail.findOne({ package: id }).session(session).lean();
    if ((current?.version ?? 0) !== version || (!current && version > 0))
      throw new WorkflowProblem(409, 'Nội dung gói đã thay đổi. Hãy tải lại trước khi lưu.');
    const versionFilter =
      version === 0
        ? { $or: [{ detailsVersion: 0 }, { detailsVersion: { $exists: false } }] }
        : { detailsVersion: version };
    const saved = await Package.findOneAndUpdate(
      { _id: id, ...versionFilter },
      { $inc: { detailsVersion: 1 } },
      { new: true, runValidators: true, session },
    ).lean();
    if (!saved)
      throw new WorkflowProblem(409, 'Gói đã thay đổi hoặc bị xóa. Hãy tải lại trước khi lưu.');
    await PackageDetail.findOneAndUpdate(
      { package: id },
      { $set: { ...packageDetailContent(details), version: version + 1 } },
      { upsert: true, new: true, runValidators: true, session },
    );
    return { ...saved, details };
  });
}
