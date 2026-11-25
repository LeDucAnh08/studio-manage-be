import mongoose, { Schema } from 'mongoose';

const schema = new Schema(
  {
    service: { type: String, enum: ['yearbook', 'concept'], required: true },
    order: { type: Schema.Types.ObjectId, required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    key: { type: String, required: true, select: false },
    fingerprint: { type: String, required: true, select: false },
    command: { type: String, enum: ['configure', 'sync', 'delivery-sync'], required: true },
    payload: { type: Schema.Types.Mixed, required: true, select: false },
    namespace: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'succeeded', 'failed'],
      default: 'pending',
      required: true,
    },
    attempts: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseToken: { type: String, select: false },
    lockedUntil: Date,
    message: String,
    completedAt: Date,
  },
  { timestamps: true },
);
schema.index({ actor: 1, key: 1 }, { unique: true });
schema.index(
  { service: 1, order: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
schema.index({ namespace: 1, status: 1, nextAttemptAt: 1, lockedUntil: 1 });
schema.index({ service: 1, order: 1, createdAt: -1 });
export default mongoose.model('BackgroundOperation', schema);
