import mongoose, { Schema } from 'mongoose';

const emailOutboxSchema = new Schema(
  {
    dedupeKey: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['verify_email', 'deposit_approved'], required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    booking: { type: Schema.Types.ObjectId, ref: 'Booking' },
    paymentReference: String,
    to: { type: String, required: true },
    mode: { type: String, enum: ['test', 'resend'], required: true },
    payload: { type: Schema.Types.Mixed, required: true, select: false },
    status: {
      type: String,
      enum: ['pending', 'sending', 'sent', 'failed', 'delivery_unknown', 'skipped'],
      default: 'pending',
      required: true,
    },
    attempts: { type: Number, default: 0 },
    deliveryUncertain: { type: Boolean, default: false },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseToken: { type: String, select: false },
    lockedUntil: Date,
    firstAttemptAt: Date,
    providerId: String,
    lastError: String,
    sentAt: Date,
    testMessage: { type: Schema.Types.Mixed, select: false },
  },
  { timestamps: true },
);
emailOutboxSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });
export default mongoose.model('EmailOutbox', emailOutboxSchema);
