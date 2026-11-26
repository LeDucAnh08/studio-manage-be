import mongoose, { Document, Schema, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { ACTIVE_ROLES, type UserRole } from './Role';

// Preserve existing imports and the numeric roles API while referencing Role documents.
export { ACTIVE_ROLES, ROLE_LABELS, type UserRole } from './Role';

// Explicitly exclude legacy or internal fields even before a database cleanup runs.
export const USER_PUBLIC_FIELDS =
  '_id username name roles isActive email emailVerifiedAt notificationReadAt sourceAccountRequest createdAt updatedAt __v';

export interface IUser extends Document {
  username: string;
  name?: string;
  password: string;
  roles: UserRole[];
  isActive: boolean;
  email?: string;
  emailVerifiedAt?: Date;
  emailVerification?: {
    tokenHash: string;
    expiresAt: Date;
    requestedAt: Date;
    windowAt: Date;
    count: number;
  };
  notificationReadAt?: Date;
  sourceAccountRequest?: Types.ObjectId;
  comparePassword(plain: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true },
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    emailVerifiedAt: Date,
    emailVerification: {
      type: new Schema(
        { tokenHash: String, expiresAt: Date, requestedAt: Date, windowAt: Date, count: Number },
        { _id: false },
      ),
      select: false,
    },
    password: { type: String, required: true, select: false },
    roles: { type: [{ type: Number, ref: 'Role', enum: ACTIVE_ROLES }], default: [6] },
    notificationReadAt: { type: Date },
    sourceAccountRequest: {
      type: Schema.Types.ObjectId,
      ref: 'AccountRequest',
      unique: true,
      sparse: true,
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

userSchema.pre<IUser>('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (plain: string): Promise<boolean> {
  return bcrypt.compare(plain, this.password);
};

export default mongoose.model<IUser>('User', userSchema);
