import mongoose, { Schema, Types } from 'mongoose';

const quoteLineSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const proposedScheduleSchema = new Schema(
  {
    shootDate: { type: Date, required: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    location: { type: String, required: true },
  },
  { _id: false },
);

const quoteSchema = new Schema(
  {
    version: { type: Number, required: true },
    currency: { type: String, default: 'VND' },
    lines: { type: [quoteLineSchema], required: true },
    depositRequired: { type: Number, required: true, min: 0 },
    proposedSchedule: { type: proposedScheduleSchema, required: true },
    delivery: {
      targetDays: { type: Number, required: true },
      targetDate: { type: Date },
    },
    editingTerms: [{ type: String, trim: true }],
    terms: [{ type: String, trim: true }],
    paymentInstructions: {
      bankName: String,
      accountName: String,
      accountNumber: String,
      transferTemplate: String,
    },
    proposedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    proposedAt: { type: Date, required: true },
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    acceptedAt: Date,
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, auto: true },
    kind: { type: String, enum: ['deposit', 'balance', 'refund'], required: true },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, enum: ['cash', 'bank_transfer', 'other'], required: true },
    reference: { type: String, trim: true },
    receivedAt: { type: Date, required: true },
    transaction: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false },
);

const costumeReservationSchema = new Schema(
  {
    costumeId: { type: Schema.Types.ObjectId, ref: 'Costume', required: true },
    size: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    receiveDate: { type: Date, required: true },
    returnDate: { type: Date, required: true },
  },
  { _id: false },
);

const memberSizeSchema = new Schema(
  {
    costumeId: { type: Schema.Types.ObjectId, ref: 'Costume', required: true },
    size: { type: String, required: true },
  },
  { _id: false },
);

const memberSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student' },
    requestId: { type: String, trim: true },
    requestFingerprint: { type: String },
    name: { type: String, required: true, trim: true },
    gender: { type: String, enum: ['male', 'female', 'other'] },
    height: { type: Number, min: 1 },
    weight: { type: Number, min: 1 },
    contact: { type: String, trim: true },
    costumeSizes: { type: [memberSizeSchema], default: [] },
  },
  { timestamps: true },
);

const revisionSchema = new Schema(
  {
    note: { type: String, required: true, trim: true },
    // Optional so older workflow revision records remain readable.
    deliveryVersion: { type: Number, min: 1 },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
    resolvedAt: Date,
  },
  { _id: true },
);

const changeRequestSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, auto: true },
    kind: { type: String, enum: ['change', 'cancel'], required: true },
    status: {
      type: String,
      enum: ['requested', 'proposed', 'accepted', 'applied', 'declined'],
      required: true,
    },
    requested: { type: Schema.Types.Mixed },
    proposed: { type: Schema.Types.Mixed },
    priceDelta: { type: Number, default: 0 },
    finalPayable: { type: Number, min: 0 },
    refundDue: { type: Number, min: 0 },
    previousLifecycle: { type: String },
    terms: [{ type: String, trim: true }],
    note: { type: String, trim: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    proposedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    proposedAt: Date,
    acceptedAt: Date,
  },
  { _id: true },
);

const eventSchema = new Schema(
  {
    action: { type: String, required: true },
    message: { type: String, required: true },
    audience: {
      type: String,
      enum: ['client', 'admin', 'accounting', 'photographer'],
      default: 'client',
    },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const idempotencySchema = new Schema(
  {
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    action: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const workflowSchema = new Schema(
  {
    booking: {
      type: Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      unique: true,
      index: true,
    },
    version: { type: Number, default: 0, min: 0 },
    lifecycle: {
      type: String,
      enum: [
        'intake',
        'quoting',
        'awaiting_deposit',
        'ready_to_confirm',
        'confirmed',
        'shooting',
        'editing',
        'delivered',
        'revision_requested',
        'accepted',
        'completed',
        'change_pending',
        'cancelled',
      ],
      default: 'intake',
      index: true,
    },
    customer: { type: Schema.Types.ObjectId, ref: 'Customer' },
    assignedPhotographer: { type: Schema.Types.ObjectId, ref: 'User' },
    assignedSupportPhotographers: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: undefined,
    },
    quote: { type: quoteSchema },
    quoteHistory: { type: [quoteSchema], default: [] },
    payments: { type: [paymentSchema], default: [] },
    resources: {
      schedule: { type: Schema.Types.ObjectId, ref: 'Schedule' },
      photographers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      costumes: { type: [costumeReservationSchema], default: [] },
    },
    members: { type: [memberSchema], default: [] },
    memberRosterHistory: {
      type: [
        new Schema(
          {
            version: Number,
            changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
            at: Date,
            members: { type: [memberSchema], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    memberEntry: {
      tokenHash: { type: String, select: false },
      opened: { type: Boolean, default: false },
      openedAt: Date,
      closedAt: Date,
    },
    progress: {
      status: {
        type: String,
        enum: ['not_started', 'shooting', 'editing', 'delivered'],
        default: 'not_started',
      },
      deliveryVersion: { type: Number, default: 0 },
      deliveryUrl: { type: String },
      deliveredAt: Date,
      acceptedAt: Date,
      acceptedDeliveryVersion: Number,
      revisionRequests: { type: [revisionSchema], default: [] },
    },
    deliveryHistory: [
      {
        _id: false,
        version: { type: Number, required: true },
        deliveryUrl: { type: String, required: true },
        deliveredAt: { type: Date, required: true },
        deliveredBy: { type: Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    changeRequest: { type: changeRequestSchema },
    changeHistory: { type: [changeRequestSchema], default: [] },
    feedback: {
      record: { type: Schema.Types.ObjectId, ref: 'Feedback' },
      rating: { type: Number, min: 1, max: 5 },
      comment: { type: String, trim: true },
      at: Date,
    },
    events: { type: [eventSchema], default: [] },
    idempotency: { type: [idempotencySchema], default: [] },
  },
  { timestamps: true, minimize: false },
);

workflowSchema.index({ 'resources.photographers': 1, lifecycle: 1 });
workflowSchema.index({ assignedPhotographer: 1, lifecycle: 1 });
workflowSchema.index({ assignedSupportPhotographers: 1, lifecycle: 1 });
workflowSchema.index({ 'members.requestId': 1 }, { sparse: true });

export interface IBookingWorkflow extends mongoose.Document {
  booking: Types.ObjectId;
  version: number;
  lifecycle: string;
  customer?: Types.ObjectId;
  assignedPhotographer?: Types.ObjectId;
  assignedSupportPhotographers?: Types.ObjectId[];
  quote?: Record<string, any>;
  quoteHistory: Array<Record<string, any>>;
  payments: Array<Record<string, any>>;
  resources: {
    schedule?: Types.ObjectId;
    photographers: Types.ObjectId[];
    costumes: Array<Record<string, any>>;
  };
  members: Array<Record<string, any>>;
  memberRosterHistory: Array<Record<string, any>>;
  memberEntry: { tokenHash?: string; opened: boolean; openedAt?: Date; closedAt?: Date };
  progress: Record<string, any>;
  deliveryHistory: Array<Record<string, any>>;
  changeRequest?: Record<string, any>;
  changeHistory: Array<Record<string, any>>;
  feedback?: Record<string, any>;
  events: Array<Record<string, any>>;
  idempotency: Array<Record<string, any>>;
  createdAt: Date;
  updatedAt: Date;
  save(options?: Record<string, unknown>): Promise<this>;
}

export default mongoose.models.BookingWorkflow ||
  mongoose.model<IBookingWorkflow>('BookingWorkflow', workflowSchema);
