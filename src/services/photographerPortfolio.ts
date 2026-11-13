import type { ClientSession } from 'mongoose';
import Profile from '../models/PhotographerProfile';
import Concept from '../models/Concept';
import User from '../models/User';
import { conceptImageUrl, objectId, text } from './conceptPolicy';
import { WorkflowProblem } from './workflowTransactions';

export const profileTextLimits = {
  bio: 2000,
  title: 120,
  tagline: 180,
  story: 4000,
  specialty: 300,
  style: 600,
  guidance: 600,
  philosophy: 1500,
};
export const profileSectionLimits = { approach: 4, audience: 4, milestones: 6 };
export const contentKeys = [
  ...Object.keys(profileTextLimits),
  ...Object.keys(profileSectionLimits),
  'portraitUrl',
  'coverUrl',
  'portfolio',
];
export function profileContent(profile: any) {
  return Object.fromEntries(
    contentKeys.map((key) => [
      key,
      profile?.[key] ?? (key === 'portfolio' || key in profileSectionLimits ? [] : ''),
    ]),
  );
}
export function profileImages(profile: any): string[] {
  return [
    profile?.portraitUrl,
    profile?.coverUrl,
    ...(Array.isArray(profile?.portfolio) ? profile.portfolio : []).map((p: any) => p?.url),
  ].filter(Boolean);
}
export const portfolioMediaUrl = (owner: string, file: string) =>
  `/api/photographers/${owner}/portfolio-media/${file}`;
export function validateProfileContent(body: any, concepts: string[], allowedImages?: Set<string>) {
  const data: any = {};
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new WorkflowProblem(400, 'Nội dung hồ sơ không hợp lệ.');
  for (const [key, max] of Object.entries(profileTextLimits))
    data[key] = text(body[key] ?? '', max, false);
  const image = (value: unknown) => {
    if (typeof value !== 'string' || (allowedImages && !allowedImages.has(value)))
      throw new WorkflowProblem(400, 'Ảnh không thuộc hồ sơ của bạn.');
    if (allowedImages?.has(value)) return value;
    return conceptImageUrl(value);
  };
  for (const key of ['portraitUrl', 'coverUrl']) data[key] = body[key] ? image(body[key]) : '';
  for (const [key, max] of Object.entries(profileSectionLimits)) {
    const rows = body[key] === undefined ? [] : body[key];
    if (!Array.isArray(rows) || rows.length > max)
      throw new WorkflowProblem(400, 'Quá nhiều mục trong hồ sơ.');
    data[key] = rows.map((row) => ({
      title: text(row?.title, 120),
      description: text(row?.description ?? '', 600, false),
    }));
  }
  if (!Array.isArray(body.portfolio) || body.portfolio.length > 100)
    throw new WorkflowProblem(400, 'Tối đa 100 ảnh tác phẩm.');
  data.portfolio = body.portfolio.map((row: any) => {
    const concept = objectId(row?.concept);
    if (!concepts.includes(concept))
      throw new WorkflowProblem(400, 'Ảnh phải thuộc concept được studio phân công.');
    return {
      concept,
      url: image(row.url),
      caption: text(row.caption ?? '', 200, false),
      permitted: row.permitted === true,
    };
  });
  return data;
}
export function assertPublishable(content: any, activeConcepts: string[]) {
  if (
    !content.portraitUrl ||
    !(content.bio || content.story)?.trim() ||
    !activeConcepts.length ||
    !content.portfolio.some((p: any) => p.permitted && activeConcepts.includes(String(p.concept)))
  )
    throw new WorkflowProblem(
      400,
      'Cần ảnh chân dung, giới thiệu, concept đang hoạt động được phân công và ít nhất một ảnh được phép công khai.',
    );
}
export const revisionFilter = (revision: number) =>
  revision === 0 ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] } : { revision };
export function expectedRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new WorkflowProblem(400, 'Thiếu phiên bản hồ sơ. Hãy tải lại.');
  return value as number;
}
export async function portfolioState(photographer: string, name: string) {
  const profile = await Profile.findOne({ photographer }).lean();
  const concepts = await Concept.find({ _id: { $in: profile?.concepts || [] } })
    .select('_id name active')
    .lean();
  return {
    photographer,
    name,
    concepts,
    content: profileContent(profile?.draft || profile),
    revision: profile?.revision || 0,
    published: profile?.published || false,
    hasDraft:
      !!profile?.draft && (!profile.published || profile.revision !== profile.publishedRevision),
  };
}
export async function publicPortfolio(photographer: string) {
  const profile = await Profile.findOne({ photographer, published: true }).lean();
  const user = await User.findOne({ _id: photographer, roles: 3, isActive: true })
    .select('_id name username')
    .lean();
  const concepts = await Concept.find({ _id: { $in: profile?.concepts || [] }, active: true })
    .select('_id name')
    .lean();
  if (!profile || !user || !concepts.length)
    throw new WorkflowProblem(404, 'Hồ sơ thợ chưa được công khai.');
  const ids = new Set(concepts.map((c) => String(c._id)));
  const content = profileContent(profile);
  return {
    _id: String(user._id),
    name: user.name || user.username,
    ...content,
    concepts,
    portfolio: profile.portfolio
      .filter((p) => p.permitted && ids.has(String(p.concept)))
      .map((p) => ({ concept: String(p.concept), url: p.url, caption: p.caption })),
  };
}
export async function saveAdminPortfolio(body: any, session: ClientSession) {
  const photographer = objectId(body.photographer);
  if (!(await User.exists({ _id: photographer, roles: 3, isActive: true }).session(session)))
    throw new WorkflowProblem(400, 'Thợ không hợp lệ.');
  if (!Array.isArray(body.concepts) || body.concepts.length > 100)
    throw new WorkflowProblem(400, 'Danh sách concept không hợp lệ.');
  const concepts = [...new Set<string>(body.concepts.map(objectId))];
  const rows = await Concept.find({ _id: { $in: concepts } })
    .session(session)
    .lean();
  if (rows.length !== concepts.length) throw new WorkflowProblem(400, 'Concept không tồn tại.');
  const old = await Profile.findOne({ photographer }).session(session).lean();
  const revision = expectedRevision(body.revision ?? (old ? undefined : 0));
  if ((old?.revision || 0) !== revision || (body.id && String(old?._id) !== body.id))
    throw new WorkflowProblem(409, 'Hồ sơ đã thay đổi. Hãy tải lại trước khi lưu.');
  const localImages = new Set([...profileImages(old), ...profileImages(old?.draft)]);
  const input = { ...profileContent(old), ...body };
  if (profileImages(input).some((url) => typeof url !== 'string'))
    throw new WorkflowProblem(400, 'Đường dẫn ảnh không hợp lệ.');
  for (const url of profileImages(input))
    if (url.startsWith('/api/photographers/') && !localImages.has(url))
      throw new WorkflowProblem(400, 'Ảnh không thuộc hồ sơ này.');
  const allowed = new Set(
    profileImages(input).map((url) => (localImages.has(url) ? url : conceptImageUrl(url))),
  );
  const content = validateProfileContent(input, concepts, allowed);
  if (body.published === true)
    assertPublishable(
      content,
      rows.filter((c) => c.active).map((c) => String(c._id)),
    );
  const data = {
    ...content,
    concepts,
    draft: content,
    published: body.published === true,
    revision: revision + 1,
    publishedRevision: body.published === true ? revision + 1 : old?.publishedRevision || 0,
  };
  if (old) {
    const saved = await Profile.updateOne(
      { _id: old._id, ...revisionFilter(revision) },
      { $set: data },
      { session, runValidators: true },
    );
    if (!saved.matchedCount) throw new WorkflowProblem(409, 'Hồ sơ đã thay đổi. Hãy tải lại.');
  } else await Profile.create([{ photographer, ...data }], { session });
}
