import { Schema } from 'mongoose';
import Album from './Album';

const schema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: 'ConceptOrder', required: true },
    status: {
      type: String,
      enum: [
        'draft',
        'selecting',
        'awaiting_extra',
        'queued',
        'retouching',
        'delivered',
        'revising',
        'completed',
      ],
      default: 'draft',
    },
    folders: { type: [String], default: [] },
    selectionRound: { type: Number, default: 0 },
    selections: { type: [Schema.Types.Mixed], default: [] },
    extraAmount: { type: Number, default: 0 },
    deliveryVersion: { type: Number, default: 0 },
    deliveries: { type: [Schema.Types.Mixed], default: [] },
    feedbackRounds: { type: [Schema.Types.Mixed], default: [] },
    paidRequests: { type: [Schema.Types.Mixed], default: [] },
    allowDownload: { type: Boolean, default: true },
    share: { publicId: String, tokenHash: { type: String, select: false }, expiresAt: Date },
    commands: { type: [{ key: String, fingerprint: String }], default: [], select: false },
  },
  { timestamps: true },
);
schema.index(
  { 'share.publicId': 1 },
  {
    unique: true,
    partialFilterExpression: { service: 'concept', 'share.publicId': { $type: 'string' } },
  },
);
export default Album.discriminator('ConceptAlbum', schema, 'concept');
