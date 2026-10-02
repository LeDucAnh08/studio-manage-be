import { Schema, model } from 'mongoose';

// Deliberately separate from Customer (school/class) and operational Schedule.
const eventSchema = new Schema({
  message: { type: String, required: true },
  audience: { type: String, enum: ['client', 'admin'], required: true },
  at: { type: Date, default: Date.now },
});

const packageSnapshotSchema = new Schema(
  {
    name: { type: String, required: true },
    pricePerMember: { type: Number, required: true },
    duration: { type: String },
    costumeIds: [{ type: Schema.Types.ObjectId }],
    crewRatio: { type: String },
    editingScope: { type: String },
    deliveryDays: { type: Number },
    studentsPerCrew: { type: Number },
    description: { type: String },
  },
  { _id: false },
);

const bookingSchema = new Schema(
  {
    client: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientRequestId: { type: String, trim: true },
    requestFingerprint: { type: String, select: false },
    package: { type: Schema.Types.ObjectId, ref: 'Package', required: true },
    packageName: { type: String, required: true },
    pricePerMember: { type: Number, required: true },
    packageSnapshot: { type: packageSnapshotSchema, required: true },
    members: { type: Number, required: true },
    className: { type: String, trim: true },
    school: { type: String, trim: true },
    contactName: { type: String, required: true },
    phone: { type: String, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    location: { type: String, required: true },
    note: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewNote: { type: String, default: '' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    events: [eventSchema],
  },
  { timestamps: true },
);
bookingSchema.index({ status: 1, createdAt: -1 });
bookingSchema.index({ client: 1, createdAt: -1 });
bookingSchema.index(
  { client: 1, clientRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientRequestId: { $type: 'string' } },
  },
);
export default model('Booking', bookingSchema);
