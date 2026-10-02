export const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;

export const normalizeUsername = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
};

export const trimmedText = (value: unknown, maxLength: number, required = true): string | null => {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maxLength) return null;
  return normalized;
};

export const boundedInteger = (value: unknown, minimum: number, maximum: number): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
};

export const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
