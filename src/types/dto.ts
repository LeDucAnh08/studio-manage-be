/**
 * Response DTOs returned to the client.
 * These types MUST stay in sync with `frontend/src/types/index.ts`.
 *
 * Rule: Model types (kept internally) hold ObjectId string references on
 * relations; Response DTOs hold fully populated documents so the frontend
 * receives a consistent, strict shape.
 */

export type UserRole = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface UserDto {
  _id: string;
  username: string;
  name?: string;
  roles: UserRole[];
  isActive: boolean;
  createdAt?: string;
}

export interface CustomerDto {
  _id: string;
  className: string;
  school?: string;
  contactName: string;
  contactPhone: string;
  contactAddress: string;
  total: number;
  totalMale?: number;
  totalFemale?: number;
  notes?: string;
  createdAt?: string;
}

export interface CostumeDto {
  _id: string;
  name: string;
  description?: string;
  gender: 'male' | 'female' | 'unisex';
  createdAt?: string;
}

export interface PackageDto {
  _id: string;
  name: string;
  pricePerMember: number;
  duration?: 'full_day' | 'half_day' | 'two_thirds_day';
  costumes?: CostumeDto[];
  crewRatio?: string;
  editingScope?: 'full' | 'partial';
  deliveryDays?: number;
  studentsPerCrew?: number;
  description?: string;
  createdAt?: string;
}

export interface CategoryDto {
  _id: string;
  name: string;
  type: 'income' | 'expense';
  isDefault: boolean;
  createdBy?: string;
}

/** Flat schedule — used for create/update payloads. */
export interface ScheduleDto {
  _id: string;
  customer: string;
  package: string | null;
  shootDate: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  leadPhotographer: string | null;
  supportPhotographers: string[];
  bookedBy: string | null;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  notes?: string;
  season?: string | null;
  contractUrl?: string;
  createdAt?: string;
}

/** Populated schedule returned by GET endpoints. */
export interface ScheduleResponse extends Omit<
  ScheduleDto,
  'customer' | 'package' | 'leadPhotographer' | 'supportPhotographers' | 'bookedBy'
> {
  customer: CustomerDto;
  package: PackageDto | null;
  leadPhotographer: UserDto | null;
  supportPhotographers: UserDto[];
  bookedBy: UserDto | null;
}

export interface TransactionDto {
  _id: string;
  customer: string | null;
  type: 'income' | 'expense';
  amount: number;
  categoryId: string;
  description?: string;
  date: string;
  createdBy: string | null;
  accountantRefunded?: boolean;
  createdAt?: string;
}

export interface TransactionResponse extends Omit<
  TransactionDto,
  'customer' | 'categoryId' | 'createdBy'
> {
  customer: CustomerDto | null;
  categoryId: CategoryDto;
  createdBy: UserDto | null;
}

export interface TransactionSummaryRow {
  _id: string | null;
  customer?: CustomerDto;
  income: number;
  expense: number;
  profit: number;
}

export interface StudentDto {
  _id: string;
  customer: string;
  name: string;
  gender: 'male' | 'female';
  height?: number;
  weight?: number;
  notes?: string;
  costumes: string[];
  createdAt?: string;
}

/** Populated student returned by GET endpoints. */
export interface StudentResponse extends Omit<StudentDto, 'costumes'> {
  costumes: CostumeDto[];
}

export interface FeedbackItemDto {
  rating: number;
  description?: string;
}

export interface FeedbackDto {
  _id: string;
  customer: string | null;
  phone?: string;
  crewFeedback: FeedbackItemDto;
  albumFeedback: FeedbackItemDto;
  content?: string;
  suggestion?: string;
  isRead: boolean;
  createdAt: string;
}

export interface FeedbackResponse extends Omit<FeedbackDto, 'customer'> {
  customer: CustomerDto | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalMale?: number;
  totalFemale?: number;
}

export interface FeedbackListResponse extends PaginatedResponse<FeedbackResponse> {
  totalRead: number;
  totalUnread: number;
}

export interface ErrorResponse {
  message: string;
}

/**
 * Public (unauthenticated) schedule shape — exposed by `/public/schedules/:customer`.
 * Intentionally narrower than `ScheduleResponse` to avoid leaking staff / booking info.
 */
export interface PublicScheduleResponse {
  _id: string;
  shootDate: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  status: ScheduleDto['status'];
  customer: Pick<CustomerDto, '_id' | 'className' | 'school'>;
  costumes: CostumeDto[];
  package: {
    _id: string;
    name: string;
  } | null;
}

/** Upcoming schedule cell shown on the dashboard. */
export interface UpcomingScheduleDto {
  _id: string;
  shootDate: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  status: ScheduleDto['status'];
  customer?: Pick<CustomerDto, '_id' | 'className' | 'school'>;
  leadPhotographer?: Pick<UserDto, '_id' | 'name' | 'username'>;
}

export interface DashboardStats {
  totals: { income: number; expense: number; profit: number };
  daily: Array<{ label: string; income: number; expense: number }>;
  customerCount: number;
  scheduleCount: number;
  showSchedules: boolean;
  upcomingSchedules: UpcomingScheduleDto[];
}

// Season DTOs
export interface SeasonDto {
  _id: string;
  name: string;
  startDate: string;
  endDate: string;
  createdAt?: string;
}

export interface SeasonResponse extends SeasonDto {}
