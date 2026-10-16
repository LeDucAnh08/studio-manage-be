import { Request, Response } from 'express';
import Costume from '../models/Costume';
import CostumeType from '../models/CostumeType';
import { sendResponse } from '../utils/response';
import { readCostumeCatalogFilters, readCostumeInput } from '../utils/costumeInput';
import Schedule from '../models/Schedule';
import BookingWorkflow from '../models/BookingWorkflow';
import RentalOrder from '../models/RentalOrder';
import {
  ensureRentalStockPreserved,
  getRentalAvailability,
  loadRentalHolds,
} from '../services/rentalAvailability';
import { readRentalPeriod } from '../utils/rentalPeriod';
import { Types } from 'mongoose';
import {
  withResourceTransaction,
  WorkflowProblem,
  resourceTransactionsRequired,
} from '../services/workflowTransactions';

const goodQuantity = (inventory: Array<any>, size: string): number =>
  inventory
    .filter((row) => row.size === size && row.condition === 'good')
    .reduce((sum, row) => sum + row.quantity, 0);
const vnDayIndex = (value: Date | string): number =>
  Math.floor((new Date(value).getTime() + 7 * 60 * 60 * 1000) / 86400000);

const ensureCostumeChangePreservesReservations = async (
  id: Types.ObjectId,
  value: any,
  session: any,
): Promise<void> => {
  const old = await Costume.findById(id).session(session).lean();
  if (!old) throw new WorkflowProblem(404, 'Not found');
  const typeChanged =
    value.type !== undefined && String(old.type ?? '') !== String(value.type ?? '');
  const inventoryChanged =
    value.inventory !== undefined &&
    JSON.stringify(old.inventory ?? []) !== JSON.stringify(value.inventory);
  if (!typeChanged && !inventoryChanged) return;
  if (inventoryChanged) await ensureRentalStockPreserved(id, value.inventory, session);
  const schedules = (await Schedule.find({
    costumes: id,
    status: { $in: ['pending', 'confirmed', 'completed'] },
  })
    .session(session)
    .lean()) as any[];
  const workflows = (await BookingWorkflow.find({
    $or: [{ 'resources.costumes.costumeId': id }, { 'members.costumeSizes.costumeId': id }],
  })
    .session(session)
    .lean()) as any[];
  if (typeChanged && (schedules.length || workflows.length))
    throw new WorkflowProblem(
      409,
      'Trang phục đang được dùng trong booking hoặc lịch chụp; không thể đổi loại',
    );
  const activeWorkflows = workflows.filter(
    (workflow) => !['cancelled', 'completed'].includes(workflow.lifecycle),
  );
  const preservesExistingGoodStock = (size: string): boolean =>
    goodQuantity(value.inventory ?? [], size) >= goodQuantity(old.inventory ?? [], size);
  const today = vnDayIndex(new Date());
  const usage = new Map<string, Map<number, number>>();
  for (const row of schedules) {
    const entries = (row.costumeReservations ?? []).filter(
      (item: any) => String(item.costume) === String(id) && vnDayIndex(item.returnDate) >= today,
    );
    if (!entries.length && vnDayIndex(row.shootDate) >= today) {
      const availableSizes = new Set(
        (old.inventory ?? [])
          .filter((item: any) => item.condition === 'good')
          .map((item: any) => item.size),
      );
      if ([...availableSizes].some((size) => !preservesExistingGoodStock(size))) {
        throw new WorkflowProblem(
          409,
          'Lịch cũ chưa đối soát kích cỡ; chỉ có thể bổ sung tồn kho cho đến khi cập nhật chi tiết giữ trang phục',
        );
      }
      // Legacy schedules without size rows cannot safely tolerate stock reductions.
      // Adding good stock is safe and lets staff restore inventory before reconciling them.
      continue;
    }
    for (const entry of entries) {
      const sizeUsage = usage.get(entry.size) ?? new Map<number, number>();
      usage.set(entry.size, sizeUsage);
      const firstDay = Math.max(today, vnDayIndex(entry.receiveDate));
      const lastDay = vnDayIndex(entry.returnDate);
      for (let day = firstDay; day <= lastDay; day += 1)
        sizeUsage.set(day, (sizeUsage.get(day) ?? 0) + entry.quantity);
    }
  }
  for (const [size, byDay] of usage) {
    const peak = Math.max(0, ...byDay.values());
    if (goodQuantity(value.inventory ?? [], size) < peak)
      throw new WorkflowProblem(409, `Tồn kho cỡ ${size} đang được lịch chụp giữ`);
  }
  for (const workflow of activeWorkflows) {
    for (const entry of workflow.resources?.costumes ?? []) {
      if (
        String(entry.costumeId) === String(id) &&
        !usage.has(entry.size) &&
        goodQuantity(value.inventory ?? [], entry.size) < entry.quantity
      ) {
        throw new WorkflowProblem(409, `Tồn kho cỡ ${entry.size} đang được booking giữ`);
      }
    }
    for (const member of workflow.members ?? []) {
      for (const selection of member.costumeSizes ?? []) {
        if (
          String(selection.costumeId) === String(id) &&
          goodQuantity(value.inventory ?? [], selection.size) < 1
        ) {
          throw new WorkflowProblem(409, `Cỡ ${selection.size} đang được thành viên booking chọn`);
        }
      }
    }
  }
};

const sendCostumeProblem = (res: Response, error: unknown): void => {
  const problem = error as WorkflowProblem;
  sendResponse(res, problem.status ?? 500, false, problem.message ?? 'Internal server error');
};

export const getAll = async (_req: Request, res: Response): Promise<void> => {
  const costumes = await Costume.find().populate('type').sort({ name: 1 });
  sendResponse(res, 200, true, 'OK', costumes);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const input = readCostumeInput(req.body);
  if (!input.ok) {
    sendResponse(res, 400, false, input.error);
    return;
  }
  let costume: any;
  if (await resourceTransactionsRequired()) {
    try {
      await withResourceTransaction(async (session) => {
        [costume] = await Costume.create([input.value], { session });
      });
    } catch (error) {
      sendCostumeProblem(res, error);
      return;
    }
  } else {
    costume = await Costume.create(input.value);
  }
  sendResponse(res, 201, true, 'Tạo trang phục thành công', costume);
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const input = readCostumeInput(req.body, true);
  if (!input.ok) {
    sendResponse(res, 400, false, input.error);
    return;
  }
  let costume: any;
  try {
    if (await resourceTransactionsRequired()) {
      await withResourceTransaction(async (session) => {
        if (!Types.ObjectId.isValid(req.params.id)) throw new WorkflowProblem(404, 'Not found');
        await ensureCostumeChangePreservesReservations(
          new Types.ObjectId(req.params.id),
          input.value,
          session,
        );
        costume = await Costume.findByIdAndUpdate(req.params.id, input.value, {
          new: true,
          runValidators: true,
          session,
        });
      });
    } else {
      if (Types.ObjectId.isValid(req.params.id))
        await ensureCostumeChangePreservesReservations(
          new Types.ObjectId(req.params.id),
          input.value,
          undefined,
        );
      costume = await Costume.findByIdAndUpdate(req.params.id, input.value, {
        new: true,
        runValidators: true,
      });
    }
  } catch (error) {
    sendCostumeProblem(res, error);
    return;
  }
  if (!costume) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Cập nhật thành công', costume);
};

export const getPublicCatalog = async (req: Request, res: Response): Promise<void> => {
  let period: ReturnType<typeof readRentalPeriod>;
  try {
    period = readRentalPeriod(req.query.receiveDate, req.query.returnDate);
  } catch (error) {
    sendCostumeProblem(res, error);
    return;
  }
  const parsed = readCostumeCatalogFilters(req.query);
  if (!parsed.ok) {
    sendResponse(res, 400, false, parsed.error);
    return;
  }

  const filter: Record<string, unknown> = { isRentalItem: true };
  if (parsed.value.itemKind) {
    // Older Costume documents have no itemKind and represent clothing.
    filter.itemKind =
      parsed.value.itemKind === 'clothing' ? { $in: ['clothing', null] } : 'accessory';
  }
  if (parsed.value.categoryId) filter.type = parsed.value.categoryId;
  if (parsed.value.size) {
    filter.inventory = {
      $elemMatch: { size: parsed.value.size, quantity: { $gt: 0 }, condition: 'good' },
    };
  }
  const price: Record<string, number> = {};
  if (parsed.value.minPrice !== undefined) price.$gte = parsed.value.minPrice;
  if (parsed.value.maxPrice !== undefined) price.$lte = parsed.value.maxPrice;
  if (Object.keys(price).length) filter.rentalDailyPrice = { ...price, $gt: 0 };

  const costumes = await Costume.find(filter)
    .select('name description gender itemKind rentalPrice rentalDailyPrice type inventory')
    .populate('type', 'name')
    .sort({ name: 1 })
    .lean();

  const { orders, schedules } = await loadRentalHolds(
    costumes.map((costume) => String(costume._id)),
  );
  // Availability is public; reservation identities and internal inventory condition stay private.
  const catalog = costumes.flatMap((costume) => {
    const type = costume.type as unknown as { _id?: unknown; name?: string } | null;
    const availableBySize = getRentalAvailability(costume, period, orders, schedules);
    const sizes = Object.keys(availableBySize).sort();
    if (!sizes.length || (parsed.value.size && !availableBySize[parsed.value.size])) return [];
    return [
      {
        _id: String(costume._id),
        name: costume.name,
        description: costume.description,
        gender: costume.gender,
        itemKind: costume.itemKind ?? 'clothing',
        categoryId: type?._id ? String(type._id) : null,
        category: type?.name ?? null,
        rentalPrice: costume.rentalPrice ?? 0,
        rentalDailyPrice:
          Number.isSafeInteger(costume.rentalDailyPrice) && (costume.rentalDailyPrice ?? 0) > 0
            ? costume.rentalDailyPrice
            : null,
        rentalDays: period.rentalDays,
        availableBySize,
        sizes,
      },
    ];
  });
  sendResponse(res, 200, true, 'OK', catalog);
};

export const getPublicCatalogCategories = async (_req: Request, res: Response): Promise<void> => {
  const typeIds = await Costume.distinct('type', { isRentalItem: true, type: { $ne: null } });
  const categories = await CostumeType.find({ _id: { $in: typeIds } })
    .select('_id name')
    .sort({ name: 1 })
    .lean();
  sendResponse(
    res,
    200,
    true,
    'OK',
    categories.map((category) => ({ _id: String(category._id), name: category.name })),
  );
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  let costume: any;
  try {
    const removeInTransaction = async (session?: any) => {
      const query = Costume.findById(req.params.id);
      if (session) query.session(session);
      const current = await query;
      if (!current) return null;
      const scheduleQuery = Schedule.exists({ costumes: current._id });
      const workflowQuery = BookingWorkflow.exists({
        $or: [
          { 'resources.costumes.costumeId': current._id },
          { 'members.costumeSizes.costumeId': current._id },
        ],
      });
      const rentalQuery = RentalOrder.exists({
        $or: [
          { 'requestedLines.costumeId': current._id },
          { 'quote.lines.costumeId': current._id },
        ],
      });
      if (session) {
        scheduleQuery.session(session);
        workflowQuery.session(session);
        rentalQuery.session(session);
      }
      if ((await scheduleQuery) || (await workflowQuery) || (await rentalQuery))
        throw new WorkflowProblem(
          409,
          'Trang phục đang được lịch hoặc booking tham chiếu nên không thể xóa',
        );
      costume = current;
      const deleteQuery = Costume.deleteOne({ _id: current._id });
      if (session) deleteQuery.session(session);
      await deleteQuery;
      return current;
    };
    if (await resourceTransactionsRequired())
      await withResourceTransaction(async (session) => {
        await removeInTransaction(session);
      });
    else await removeInTransaction();
  } catch (error) {
    sendCostumeProblem(res, error);
    return;
  }
  if (!costume) {
    sendResponse(res, 404, false, 'Not found');
    return;
  }
  sendResponse(res, 200, true, 'Đã xóa trang phục');
};
