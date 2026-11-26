import Role, { ACTIVE_ROLES, ROLE_LABELS, type UserRole } from '../models/Role';

const descriptions: Record<UserRole, string> = {
  0: 'Quản trị cao nhất, bao gồm quản lý tài khoản Superadmin.',
  1: 'Quản trị hoạt động studio, tài khoản, đơn dịch vụ và thu chi.',
  3: 'Thực hiện lịch chụp, hậu kỳ và bàn giao các đơn được phân công.',
  6: 'Đặt dịch vụ, thanh toán, cung cấp thông tin và nhận ảnh.',
};

/** Add missing role records without rewriting accounts or existing role metadata. */
export async function ensureRoles(): Promise<number> {
  const now = new Date();
  const result = await Role.bulkWrite(
    ACTIVE_ROLES.map((_id) => ({
      updateOne: {
        filter: { _id },
        update: {
          $setOnInsert: {
            _id,
            name: ROLE_LABELS[_id],
            description: descriptions[_id],
            createdAt: now,
            updatedAt: now,
          },
        },
        upsert: true,
        timestamps: false,
      },
    })),
  );
  return result.upsertedCount;
}
