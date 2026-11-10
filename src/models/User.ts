import mongoose, { Document, Schema, Types } from 'mongoose';
import bcrypt from 'bcryptjs';

// 0: Superadmin | 1: Admin | 2: Sale | 3: Thợ chụp ảnh | 4: Cộng tác viên sale | 5: Kế toán
export type UserRole = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const ROLE_LABELS: Record<UserRole, string> = {
  0: 'Superadmin',
  1: 'Admin',
  2: 'Sale',
  3: 'Thợ chụp ảnh',
  4: 'Cộng tác viên sale',
  5: 'Kế toán',
  6: 'Khách hàng',
};

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
  telegramId?: string;
  telegramUsername?: string;
  telegramLinkToken?: string;
  telegramLinkTokenExpiry?: Date;
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
    roles: { type: [{ type: Number, enum: [0, 1, 2, 3, 4, 5, 6] }], default: [2] },
    notificationReadAt: { type: Date },
    sourceAccountRequest: {
      type: Schema.Types.ObjectId,
      ref: 'AccountRequest',
      unique: true,
      sparse: true,
    },
    isActive: { type: Boolean, default: true },
    telegramId: { type: String, default: null, sparse: true },
    telegramUsername: { type: String, default: null },
    telegramLinkToken: { type: String, default: null, select: false },
    telegramLinkTokenExpiry: { type: Date, default: null, select: false },
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
