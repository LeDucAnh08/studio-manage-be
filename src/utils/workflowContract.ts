export interface ContractQuote {
  version: number;
  acceptedAt: Date | string;
  lines: Array<{ label: string; quantity: number; unitPrice: number }>;
  depositRequired: number;
  terms: string[];
  editingTerms: string[];
  delivery: { targetDays: number; targetDate?: Date | string };
  proposedSchedule: {
    shootDate: Date | string;
    startTime: string;
    endTime: string;
    location: string;
  };
}

/** Only accepted snapshots can become a contract; never use the live package price. */
export function selectAcceptedContractQuote(
  current: unknown,
  history: unknown[],
  version?: number,
): ContractQuote | null {
  const candidates = [...history, current].filter((value): value is ContractQuote => {
    if (!value || typeof value !== 'object') return false;
    const quote = value as Partial<ContractQuote>;
    return (
      !!quote.acceptedAt &&
      Number.isSafeInteger(quote.version) &&
      Array.isArray(quote.lines) &&
      Array.isArray(quote.terms) &&
      Array.isArray(quote.editingTerms) &&
      !!quote.delivery &&
      !!quote.proposedSchedule
    );
  });
  return (
    candidates
      .filter((quote) => version === undefined || quote.version === version)
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

export function acceptedContractTerms(quote: ContractQuote): string[] {
  const money = (amount: number) => `${amount.toLocaleString('vi-VN')} đ`;
  const total = quote.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  return [
    `Báo giá phiên bản ${quote.version}, khách đã đồng ý ngày ${new Date(quote.acceptedAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.`,
    ...quote.lines.map(
      (line) =>
        `${line.label}: ${line.quantity} × ${money(line.unitPrice)} = ${money(line.quantity * line.unitPrice)}.`,
    ),
    `Tổng giá trị theo báo giá đã chốt: ${money(total)}. Tiền cọc yêu cầu: ${money(quote.depositRequired)}.`,
    `Thời hạn bàn giao: ${quote.delivery.targetDays} ngày kể từ ngày chụp${quote.delivery.targetDate ? `; dự kiến ${new Date(quote.delivery.targetDate).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}` : ''}.`,
    ...quote.editingTerms.map((term) => `Phạm vi chỉnh sửa: ${term}`),
    ...quote.terms,
  ];
}
