import mongoose, { Document, Schema } from 'mongoose';

// These numeric primary keys are also the existing User.roles values.
// Retired IDs 2, 4 and 5 must never be reassigned.
export type UserRole = 0 | 1 | 3 | 6;
export const ACTIVE_ROLES: UserRole[] = [0, 1, 3, 6];
export const ROLE_LABELS: Record<UserRole, string> = {
  0: 'Superadmin',
  1: 'Admin',
  3: 'Thợ chụp ảnh',
  6: 'Khách hàng',
};

export interface IRole extends Document<number> {
  _id: UserRole;
  name: string;
  description: string;
}

const roleSchema = new Schema<IRole>(
  {
    _id: { type: Number, required: true, enum: ACTIVE_ROLES },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

export default mongoose.model<IRole>('Role', roleSchema);
