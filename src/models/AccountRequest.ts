import mongoose, { Document, Schema } from 'mongoose';
import type { UserRole } from './User';

export type AccountRequestStatus = 'pending' | 'approved' | 'rejected';

export interface IAccountRequest extends Document {
  username: string;
  name: string;
  phone?: string;
  note?: string;
  passwordHash?: string;
  requestedRole: UserRole;
  status: AccountRequestStatus;
  reviewNote?: string;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  reviewLockToken?: string;
  reviewLockExpiresAt?: Date;
}

const accountRequestSchema = new Schema<IAccountRequest>(
  {
    username: { type: String, required: true, trim: true, lowercase: true, unique: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    note: { type: String, trim: true, maxlength: 1000 },
    passwordHash: { type: String, required: true, select: false },
    requestedRole: { type: Number, enum: [2, 3, 4, 5], required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewNote: { type: String, trim: true, maxlength: 1000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewLockToken: { type: String, select: false },
    reviewLockExpiresAt: { type: Date, select: false },
  },
  { timestamps: true },
);

accountRequestSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<IAccountRequest>('AccountRequest', accountRequestSchema);
