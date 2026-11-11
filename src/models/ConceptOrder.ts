import { Schema, model } from 'mongoose';

const costume = new Schema(
  {
    costumeId: { type: Schema.Types.ObjectId, ref: 'Costume', required: true },
    name: String,
    size: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);
const request = new Schema({
  kind: { type: String, enum: ['deposit', 'balance', 'extra', 'revision'], required: true },
  reference: { type: String, required: true },
  amount: { type: Number, required: true, min: 1 },
  received: { type: Number, default: 0 },
  mode: String,
  bankCode: String,
  bankGateway: String,
  accountNumber: String,
  accountName: String,
  bankName: String,
  status: { type: String, enum: ['pending', 'paid', 'void'], default: 'pending' },
  expiresAt: Date,
  createdAt: { type: Date, default: Date.now },
});
const schema = new Schema(
  {
    client: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    concept: { type: Schema.Types.ObjectId, ref: 'Concept', required: true },
    package: { type: Schema.Types.ObjectId, ref: 'ConceptPackage', required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    contactName: { type: String, required: true },
    phone: { type: String, required: true },
    people: { type: Number, required: true },
    brief: { type: String, maxlength: 4000, default: '' },
    references: { type: [String], default: [] },
    photographer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    editor: { type: Schema.Types.ObjectId, ref: 'User' },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    originalStartAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['awaiting_deposit', 'confirmed', 'shot', 'completed', 'expired', 'cancelled'],
      default: 'awaiting_deposit',
      index: true,
    },
    reservation: {
      status: { type: String, enum: ['held', 'transferred', 'released'], default: 'held' },
      expiresAt: { type: Date, required: true },
    },
    costumes: { type: [costume], default: [] },
    wardrobeMeasurements: {
      type: [
        {
          _id: false,
          size: { type: String, required: true, maxlength: 12 },
          heightCm: { type: Number, required: true, min: 30, max: 250 },
          weightKg: { type: Number, required: true, min: 1, max: 350 },
        },
      ],
      default: [],
    },
    wardrobe: { type: String, enum: ['pending', 'prepared', 'returned'], default: 'pending' },
    schedule: { type: Schema.Types.ObjectId, ref: 'Schedule' },
    shotAt: Date,
    rescheduleCount: { type: Number, default: 0 },
    paymentRequests: { type: [request], default: [] },
    payments: [
      {
        amount: Number,
        kind: String,
        reference: String,
        receipt: Schema.Types.ObjectId,
        at: Date,
        actor: Schema.Types.ObjectId,
      },
    ],
    refundDue: { type: Number, default: 0 },
    retained: { type: Number, default: 0 },
    version: { type: Number, default: 0 },
    checkoutKey: { type: String, required: true },
    fingerprint: { type: String, required: true, select: false },
    commands: { type: [{ key: String, fingerprint: String }], default: [], select: false },
    events: [{ action: String, message: String, at: Date, actor: Schema.Types.ObjectId }],
  },
  { timestamps: true },
);
schema.index({ client: 1, checkoutKey: 1 }, { unique: true });
schema.index({ 'paymentRequests.reference': 1 });
schema.index({ photographer: 1, status: 1, startAt: 1 });
schema.index({ 'reservation.status': 1, 'reservation.expiresAt': 1 });
export default model('ConceptOrder', schema);
