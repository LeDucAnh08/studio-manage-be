export const COSTUME_SIZES = [
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  'XXXL',
  'FREE',
  '36',
  '37',
  '38',
  '39',
  '40',
  '41',
  '42',
  '43',
  '44',
  '45',
] as const;

export const COSTUME_CONDITIONS = ['good', 'repair', 'damaged', 'retired'] as const;
export const COSTUME_ITEM_KINDS = ['clothing', 'accessory'] as const;

type CostumeCondition = (typeof COSTUME_CONDITIONS)[number];
type CostumeItemKind = (typeof COSTUME_ITEM_KINDS)[number];

export interface CostumeInventoryInput {
  size: (typeof COSTUME_SIZES)[number];
  quantity: number;
  condition: CostumeCondition;
}

export interface CostumeInput {
  name?: string;
  description?: string;
  gender?: 'male' | 'female' | 'unisex';
  type?: string | null;
  itemKind?: CostumeItemKind;
  isRentalItem?: boolean;
  rentalPrice?: number;
  rentalDailyPrice?: number | null;
  inventory?: CostumeInventoryInput[];
}

export type InputResult<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const isObjectId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

export const readCostumeInput = (body: unknown, partial = false): InputResult<CostumeInput> => {
  if (!isRecord(body)) return { ok: false, error: 'Dữ liệu trang phục không hợp lệ' };

  const allowed = new Set([
    'name',
    'description',
    'gender',
    'type',
    'itemKind',
    'isRentalItem',
    'rentalPrice',
    'rentalDailyPrice',
    'inventory',
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return { ok: false, error: 'Dữ liệu có trường không được phép cập nhật' };
  }

  const value: CostumeInput = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) {
      return { ok: false, error: 'Tên sản phẩm phải có từ 1 đến 120 ký tự' };
    }
    value.name = body.name.trim();
  } else if (!partial) {
    return { ok: false, error: 'Tên sản phẩm là bắt buộc' };
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.trim().length > 2000) {
      return { ok: false, error: 'Mô tả không hợp lệ' };
    }
    value.description = body.description.trim();
  }

  if (body.gender !== undefined) {
    if (typeof body.gender !== 'string' || !['male', 'female', 'unisex'].includes(body.gender)) {
      return { ok: false, error: 'Giới tính không hợp lệ' };
    }
    value.gender = body.gender as CostumeInput['gender'];
  }

  if (body.type !== undefined) {
    if (body.type === null || body.type === '') value.type = null;
    else if (typeof body.type !== 'string' || !isObjectId(body.type)) {
      return { ok: false, error: 'Loại sản phẩm không hợp lệ' };
    } else value.type = body.type;
  }

  if (body.itemKind !== undefined) {
    if (!COSTUME_ITEM_KINDS.includes(body.itemKind as CostumeItemKind)) {
      return { ok: false, error: 'Loại mặt hàng không hợp lệ' };
    }
    value.itemKind = body.itemKind as CostumeItemKind;
  }

  if (body.isRentalItem !== undefined) {
    if (typeof body.isRentalItem !== 'boolean') {
      return { ok: false, error: 'Trạng thái cho thuê không hợp lệ' };
    }
    value.isRentalItem = body.isRentalItem;
  }

  if (body.rentalPrice !== undefined) {
    const price = parseNonNegativeInteger(body.rentalPrice);
    if (price === null) return { ok: false, error: 'Giá thuê phải là số nguyên không âm' };
    value.rentalPrice = price;
  }

  if (body.rentalDailyPrice !== undefined) {
    if (body.rentalDailyPrice === null) value.rentalDailyPrice = null;
    else {
      const price = parseNonNegativeInteger(body.rentalDailyPrice);
      if (price === null || price === 0)
        return { ok: false, error: 'Giá thuê/ngày phải là số nguyên dương hoặc để trống' };
      value.rentalDailyPrice = price;
    }
  }

  if (body.inventory !== undefined) {
    if (!Array.isArray(body.inventory) || body.inventory.length > COSTUME_SIZES.length * 4) {
      return { ok: false, error: 'Danh sách tồn kho không hợp lệ' };
    }
    const inventory: CostumeInventoryInput[] = [];
    const keys = new Set<string>();
    for (const item of body.inventory) {
      if (
        !isRecord(item) ||
        Object.keys(item).some((key) => !['size', 'quantity', 'condition'].includes(key))
      ) {
        return { ok: false, error: 'Thông tin tồn kho không hợp lệ' };
      }
      if (!COSTUME_SIZES.includes(item.size as (typeof COSTUME_SIZES)[number])) {
        return { ok: false, error: 'Kích cỡ sản phẩm không hợp lệ' };
      }
      const quantity = parseNonNegativeInteger(item.quantity);
      if (quantity === null) return { ok: false, error: 'Số lượng phải là số nguyên không âm' };
      const condition = item.condition === undefined ? 'good' : item.condition;
      if (!COSTUME_CONDITIONS.includes(condition as CostumeCondition)) {
        return { ok: false, error: 'Tình trạng sản phẩm không hợp lệ' };
      }
      const key = `${item.size}:${condition}`;
      if (keys.has(key))
        return { ok: false, error: 'Không được lặp kích cỡ và tình trạng tồn kho' };
      keys.add(key);
      inventory.push({
        size: item.size as CostumeInventoryInput['size'],
        quantity,
        condition: condition as CostumeCondition,
      });
    }
    value.inventory = inventory;
  }

  if (partial && Object.keys(value).length === 0) {
    return { ok: false, error: 'Chưa có thông tin cần cập nhật' };
  }

  return { ok: true, value };
};

export interface CostumeCatalogFilters {
  itemKind?: CostumeItemKind;
  categoryId?: string;
  size?: (typeof COSTUME_SIZES)[number];
  minPrice?: number;
  maxPrice?: number;
}

const readFilterPrice = (value: unknown): number | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return parseNonNegativeInteger(value);
};

export const readCostumeCatalogFilters = (query: unknown): InputResult<CostumeCatalogFilters> => {
  if (!isRecord(query)) return { ok: false, error: 'Bộ lọc không hợp lệ' };
  const filters: CostumeCatalogFilters = {};
  if (query.itemKind !== undefined) {
    if (!COSTUME_ITEM_KINDS.includes(query.itemKind as CostumeItemKind)) {
      return { ok: false, error: 'Loại mặt hàng không hợp lệ' };
    }
    filters.itemKind = query.itemKind as CostumeItemKind;
  }
  if (query.categoryId !== undefined) {
    if (typeof query.categoryId !== 'string' || !isObjectId(query.categoryId)) {
      return { ok: false, error: 'Danh mục không hợp lệ' };
    }
    filters.categoryId = query.categoryId;
  }
  if (query.size !== undefined) {
    if (!COSTUME_SIZES.includes(query.size as (typeof COSTUME_SIZES)[number])) {
      return { ok: false, error: 'Kích cỡ không hợp lệ' };
    }
    filters.size = query.size as CostumeCatalogFilters['size'];
  }
  const minPrice = readFilterPrice(query.minPrice);
  const maxPrice = readFilterPrice(query.maxPrice);
  if (minPrice === null || maxPrice === null) {
    return { ok: false, error: 'Khoảng giá thuê không hợp lệ' };
  }
  if (minPrice !== undefined) filters.minPrice = minPrice;
  if (maxPrice !== undefined) filters.maxPrice = maxPrice;
  if (
    filters.minPrice !== undefined &&
    filters.maxPrice !== undefined &&
    filters.minPrice > filters.maxPrice
  ) {
    return { ok: false, error: 'Giá tối thiểu không được lớn hơn giá tối đa' };
  }
  return { ok: true, value: filters };
};
