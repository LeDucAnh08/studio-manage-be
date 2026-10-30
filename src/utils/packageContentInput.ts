import type { PackageDetailsInput } from '../types/packageContent';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Nội dung gói không hợp lệ.');
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, max = 4000): string => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008]/.test(value)) {
    throw new Error(`Nội dung phải là văn bản, tối đa ${max} ký tự.`);
  }
  return value.trim();
};

const rows = <T>(value: unknown, parse: (row: unknown) => T, max = 30): T[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`Mỗi mục chỉ được có tối đa ${max} dòng.`);
  }
  return value.map(parse);
};

const required = (value: unknown, label: string, max = 200): string => {
  const result = text(value, max);
  if (!result) throw new Error(`Vui lòng nhập ${label}.`);
  return result;
};

export function readPackageContent(raw: unknown, filesCount: number) {
  const body = record(raw);
  if (!Number.isSafeInteger(body.version) || (body.version as number) < 0) {
    throw new Error('Phiên bản nội dung không hợp lệ. Hãy tải lại trang.');
  }
  const input = record(body.details);
  const usedImages = new Set<string>();
  const uploads = new Set<number>();
  const details: PackageDetailsInput = {
    audience: text(input.audience),
    benefits: rows(input.benefits, (item) => required(item, 'quyền lợi', 500)),
    exclusions: rows(input.exclusions, (item) => required(item, 'khoản không bao gồm', 500)),
    itinerary: rows(input.itinerary, (item) => {
      const row = record(item);
      return {
        time: required(row.time, 'mốc thời gian', 80),
        title: required(row.title, 'hoạt động'),
        description: text(row.description, 2000),
      };
    }),
    process: rows(input.process, (item) => {
      const row = record(item);
      return { title: required(row.title, 'tên bước'), description: text(row.description, 2000) };
    }),
    extraCosts: rows(input.extraCosts, (item) => {
      const row = record(item);
      return {
        name: required(row.name, 'tên chi phí'),
        priceLabel: required(row.priceLabel, 'mức phí'),
        condition: text(row.condition, 2000),
      };
    }),
    preparationNotes: text(input.preparationNotes),
    depositPolicy: text(input.depositPolicy),
    cancellationPolicy: text(input.cancellationPolicy),
    priceNotes: text(input.priceNotes),
    gallery: rows(
      input.gallery,
      (item) => {
        const row = record(item);
        const alt = required(row.alt, 'mô tả ảnh', 300);
        const caption = text(row.caption, 500);
        if (row.id !== undefined) {
          if (
            row.uploadIndex !== undefined ||
            typeof row.id !== 'string' ||
            !/^[a-f0-9-]{36}\.webp$/.test(row.id) ||
            usedImages.has(row.id)
          ) {
            throw new Error('Tham chiếu ảnh không hợp lệ hoặc bị trùng.');
          }
          usedImages.add(row.id);
          return { id: row.id, alt, caption };
        }
        const index = row.uploadIndex;
        if (
          !Number.isInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= filesCount ||
          uploads.has(index as number)
        ) {
          throw new Error('File ảnh không hợp lệ hoặc bị trùng.');
        }
        uploads.add(index as number);
        return { uploadIndex: index as number, alt, caption };
      },
      10,
    ),
  };
  if (uploads.size !== filesCount) throw new Error('Có file ảnh chưa được gắn vào bộ ảnh.');
  return { version: body.version as number, details };
}
