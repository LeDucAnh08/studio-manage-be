export type BookingWorkflowLifecycle =
  | 'intake'
  | 'quoting'
  | 'awaiting_deposit'
  | 'ready_to_confirm'
  | 'confirmed'
  | 'shooting'
  | 'editing'
  | 'delivered'
  | 'revision_requested'
  | 'accepted'
  | 'completed'
  | 'change_pending'
  | 'cancelled';

export type BookingWorkflowAction =
  | 'quote.propose'
  | 'quote.accept'
  | 'payment.record'
  | 'resources.confirm'
  | 'progress.update'
  | 'revision.request'
  | 'delivery.accept'
  | 'feedback.submit'
  | 'change.request'
  | 'change.propose'
  | 'change.accept'
  | 'change.decline'
  | 'change.withdraw'
  | 'member-link.open'
  | 'member-link.close'
  | 'legacy.reconcile';

export interface BookingWorkflowCommand {
  expectedVersion: number;
  action: BookingWorkflowAction;
  [key: string]: unknown;
}

export interface BookingWorkflowDto {
  booking: {
    _id: string;
    status: 'pending' | 'approved' | 'rejected';
    packageName: string;
    pricePerMember: number;
    members: number;
    className?: string;
    school?: string;
    contactName?: string;
    phone?: string;
    startAt: string;
    endAt: string;
    location: string;
    note?: string;
    costumeSelections?: Array<{
      costumeId: string;
      name: string;
      typeId: string;
      typeName: string;
      size: string;
      quantity: number;
    }>;
    costumeHold?: {
      status: 'temporary' | 'expired' | 'approved' | 'released' | 'transferred';
      receiveDate: string;
      returnDate: string;
      expiresAt?: string;
      releaseReason?: string;
    } | null;
  };
  workflow: {
    bookingId: string;
    version: number;
    lifecycle: BookingWorkflowLifecycle;
    quote: null | {
      version: number;
      currency: string;
      lines: Array<{ label: string; quantity: number; unitPrice: number }>;
      total: number;
      depositRequired: number;
      proposedSchedule: { shootDate: string; startTime: string; endTime: string; location: string };
      delivery: { targetDays: number; targetDate?: string };
      editingTerms: string[];
      terms: string[];
      paymentInstructions: PaymentInstructions;
      acceptedAt?: string;
    };
    quoteHistory: Array<{
      version: number;
      total: number;
      depositRequired: number;
      acceptedAt?: string;
    }>;
    payments: null | {
      requiredDeposit: number;
      totalReceived: number;
      totalRefunded: number;
      netReceived: number;
      totalDue: number;
      refundDue?: number;
      entries: Array<{
        _id: string;
        kind: 'deposit' | 'balance' | 'refund';
        amount: number;
        method: string;
        reference?: string;
        receivedAt: string;
      }>;
    };
    resources: null | {
      scheduleId: string | null;
      scheduleDetails: null | {
        shootDate: string;
        startTime?: string;
        endTime?: string;
        location?: string;
      };
      photographers: string[];
      costumes: Array<{
        costumeId: string;
        size: string;
        quantity: number;
        receiveDate: string;
        returnDate: string;
      }>;
    };
    allowedCostumes: Array<{ costumeId: string; name: string; sizes: string[] }>;
    members: Array<{
      _id: string;
      studentId: string | null;
      name: string;
      gender?: string;
      height?: number;
      weight?: number;
      contact?: string;
      costumeSizes: Array<{ costumeId: string; size: string }>;
    }>;
    progress: null | {
      status: 'not_started' | 'shooting' | 'editing' | 'delivered';
      deliveryVersion: number;
      deliveryUrl?: string;
      deliveredAt?: string;
      acceptedAt?: string;
      acceptedDeliveryVersion?: number;
      revisionRequests: Array<{
        _id: string;
        note: string;
        deliveryVersion?: number;
        at: string;
        resolvedAt?: string;
      }>;
    };
    deliveryHistory: Array<{ version: number; deliveryUrl: string; deliveredAt: string }>;
    changeRequest: null | {
      _id: string;
      kind: 'change' | 'cancel';
      status: 'requested' | 'proposed' | 'accepted' | 'applied' | 'declined';
      requested?: Record<string, unknown>;
      proposed?: Record<string, unknown>;
      priceDelta: number;
      finalPayable?: number;
      refundDue?: number;
      terms: string[];
      note?: string;
      at: string;
    };
    changeHistory?: Array<{
      _id: string;
      kind: 'change' | 'cancel';
      status: 'requested' | 'proposed' | 'accepted' | 'applied' | 'declined';
      finalPayable?: number;
      refundDue?: number;
      terms: string[];
      at: string;
    }>;
    feedback: null | { rating: number; comment?: string; at: string };
    paymentInstructions: PaymentInstructions;
    paymentReady: boolean;
    events: Array<{ action: string; message: string; at: string }>;
    memberEntry: null | {
      opened: boolean;
      url?: string;
      token?: string;
      expiresAt?: string | null;
    };
    createdAt?: string;
    updatedAt?: string;
  };
}

export interface PaymentInstructions {
  bankName: string;
  accountName: string;
  accountNumber: string;
  transferTemplate: string;
}

export interface PublicMemberIntakeDto {
  bookingTitle: string;
  packageName: string;
  requestedMembers: number;
  allowedCostumes: Array<{ costumeId: string; name: string; sizes: string[] }>;
}

export interface PublicMemberSubmission {
  requestId: string;
  name: string;
  gender?: 'male' | 'female' | 'other';
  height?: number;
  weight?: number;
  contact?: string;
  costumeSizes: Array<{ costumeId: string; size: string }>;
}

export interface WorkflowSummary {
  bookingId: string;
  version: number;
  lifecycle: BookingWorkflowLifecycle;
  packageName: string;
  className?: string;
  shootDate: string | null;
  updatedAt: string;
  bookingStatus: 'pending' | 'approved' | 'rejected';
  progressStatus?: string;
  payment?: { netReceived: number; totalDue: number; refundDue?: number };
}
