import { Router, Request, Response } from 'express';
import type { Types } from 'mongoose';
import Customer from '../models/Customer';
import Student from '../models/Student';
import Schedule from '../models/Schedule';
import Package from '../models/Package';
import * as costumeController from '../controllers/costumeController';
import * as feedbackController from '../controllers/feedbackController';
import type { CostumeDto, PublicScheduleResponse } from '../types/dto';
import { sendResponse } from '../utils/response';
import { getPublicMemberIntake, submitPublicMember } from '../controllers/workflowController';
import { isValidObjectId } from 'mongoose';
import Costume from '../models/Costume';
import { getRentalAvailability, loadRentalHolds } from '../services/rentalAvailability';
import { vietnamDay } from '../utils/rentalPeriod';
import { asyncHandler } from '../middleware/asyncHandler';
import { getPublicPackage, validatePackageId } from '../controllers/packageContentController';

const router = Router();

const hasCustomerAccess = async (customerId: string, access: unknown): Promise<boolean> => {
  if (typeof access !== 'string' || !access) return false;
  const customer = await Customer.findOne({ _id: customerId }).select('+publicAccessToken');
  return !!customer?.publicAccessToken && customer.publicAccessToken === access;
};

// Submit feedback (public, no auth)
router.post('/feedback', feedbackController.submit);
router.get('/member-intake/:token', (req, res, next) =>
  getPublicMemberIntake(req, res).catch(next),
);
router.post('/member-intake/:token', (req, res, next) => submitPublicMember(req, res).catch(next));

// List packages (public, used by portfolio pricing section)
router.get('/packages/:id', validatePackageId, asyncHandler(getPublicPackage));
router.get('/packages', async (_req: Request, res: Response): Promise<void> => {
  const packages = await Package.find({})
    .select(
      'name pricePerMember duration crewRatio editingScope deliveryDays studentsPerCrew description costumes isPopular',
    )
    .populate('costumes', 'name')
    .sort({ pricePerMember: 1 });
  sendResponse(res, 200, true, 'OK', packages);
});

// Public catalog requires receiveDate/returnDate; confirmation rechecks availability atomically.
router.get(
  '/packages/:id/costumes',
  asyncHandler(async (req, res) => {
    const start = new Date(typeof req.query.startAt === 'string' ? req.query.startAt : '');
    const end = new Date(typeof req.query.endAt === 'string' ? req.query.endAt : '');
    if (
      !isValidObjectId(req.params.id) ||
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start <= new Date() ||
      end <= start ||
      end.getTime() - start.getTime() > 7 * 86400000
    ) {
      sendResponse(res, 400, false, 'Chọn gói và thời gian trong tương lai, tối đa 7 ngày.');
      return;
    }
    const pkg = await Package.findById(req.params.id).populate('costumes', 'name').lean();
    if (!pkg) {
      sendResponse(res, 404, false, 'Gói dịch vụ không còn tồn tại');
      return;
    }
    const types = (pkg.costumes ?? []) as unknown as Array<{ _id: unknown; name: string }>;
    const costumes = await Costume.find({
      type: { $in: types.map((type) => type._id) },
      itemKind: 'clothing',
    })
      .select('name description gender type inventory')
      .sort({ name: 1 })
      .lean();
    const { orders, schedules } = await loadRentalHolds(costumes.map((item) => String(item._id)));
    const period = { receiveDate: vietnamDay(start), returnDate: vietnamDay(end) };
    const data = costumes.map((costume) => ({
      _id: String(costume._id),
      name: costume.name,
      description: costume.description,
      gender: costume.gender,
      typeId: String(costume.type),
      typeName: types.find((type) => String(type._id) === String(costume.type))?.name ?? '',
      availableBySize: getRentalAvailability(costume, period, orders, schedules),
    }));
    sendResponse(res, 200, true, 'OK', data);
  }),
);

router.get('/costumes', costumeController.getPublicCatalog);
router.get('/costume-types', costumeController.getPublicCatalogCategories);

// Get class info by id (for form title)
router.get('/customers/:id', async (req: Request, res: Response): Promise<void> => {
  if (!(await hasCustomerAccess(req.params.id, req.query.access))) {
    sendResponse(res, 404, false, 'Không tìm thấy form hoặc link không hợp lệ');
    return;
  }
  const customer = await Customer.findById(req.params.id).select('className school');
  if (!customer) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'OK', customer);
});

// Get students by class (for display on public form)
router.get('/students', async (req: Request, res: Response): Promise<void> => {
  const { customer, access } = req.query as Record<string, string>;
  if (!customer || !(await hasCustomerAccess(customer, access))) {
    sendResponse(res, 404, false, 'Không tìm thấy form hoặc link không hợp lệ');
    return;
  }
  // A class-wide link is for intake, not roster access. Preserve the old array
  // response for existing screens while ensuring one family cannot read peers.
  const total = await Student.countDocuments({ customer });
  sendResponse(res, 200, true, 'OK', [], { total, page: 1, limit: 0 });
});

// Submit student info (public)
router.post('/students', async (req: Request, res: Response): Promise<void> => {
  const { customer, access, name, gender, height, weight, notes, costumes } = req.body;
  if (!customer || !name || !gender || !(await hasCustomerAccess(customer, access))) {
    sendResponse(res, 400, false, 'customer, name và gender là bắt buộc');
    return;
  }
  const student = await Student.create({
    customer,
    name,
    gender,
    height,
    weight,
    notes,
    costumes: Array.isArray(costumes) ? costumes : [],
  });
  sendResponse(res, 201, true, 'Tạo học sinh thành công', student);
});

// Get shoot schedule by class (public, minimal fields)
router.get('/schedules/customer/:customer', async (req: Request, res: Response): Promise<void> => {
  if (!(await hasCustomerAccess(req.params.customer, req.query.access))) {
    sendResponse(res, 404, false, 'Không tìm thấy form hoặc link không hợp lệ');
    return;
  }
  const schedule = await Schedule.findOne({ customer: req.params.customer })
    .select('shootDate startTime endTime location status package customer costumes')
    .populate('costumes', '_id name description gender type createdAt')
    .populate({
      path: 'package',
      select: 'name',
    })
    .populate('customer', 'className school')
    .sort({ shootDate: 1 })
    .lean<{
      _id: Types.ObjectId;
      shootDate: Date;
      startTime?: string;
      endTime?: string;
      location?: string;
      status: PublicScheduleResponse['status'];
      customer: {
        _id: Types.ObjectId;
        className: string;
        school?: string;
      };
      package: {
        _id: Types.ObjectId;
        name: string;
      } | null;
      costumes: CostumeDto[];
    } | null>();

  if (!schedule) {
    sendResponse(res, 200, true, 'OK', null);
    return;
  }

  const response: PublicScheduleResponse = {
    _id: String(schedule._id),
    shootDate: new Date(schedule.shootDate).toISOString(),
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    location: schedule.location,
    status: schedule.status,
    costumes: schedule.costumes,
    customer: {
      _id: String(schedule.customer._id),
      className: schedule.customer.className,
      school: schedule.customer.school,
    },
    package: schedule.package
      ? {
          _id: String(schedule.package._id),
          name: schedule.package.name,
        }
      : null,
  };

  sendResponse(res, 200, true, 'OK', response);
});

export default router;
