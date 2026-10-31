import { WorkflowProblem } from './workflowTransactions';
import { vietnamDay } from './rentalAvailability';

export function readPackageAgreement(
  input: unknown,
  pkg: any,
  members: number,
  start: Date,
  end: Date,
) {
  if (input === undefined) return undefined; // Legacy API clients remain on the consultation workflow.
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new WorkflowProblem(400, 'Vui lòng xác nhận giá và điều kiện gói trước khi gửi.');
  const value = input as Record<string, unknown>;
  const depositPercent = pkg.depositPercent ?? 30;
  const holdHours = pkg.depositHoldHours ?? 24;
  if (value.accepted !== true)
    throw new WorkflowProblem(400, 'Vui lòng đồng ý thông tin gói và tiền cọc.');
  if (!Number.isSafeInteger(pkg.pricePerMember) || pkg.pricePerMember <= 0)
    throw new WorkflowProblem(400, 'Gói này cần liên hệ studio để được tư vấn riêng.');
  if (
    value.pricePerMember !== pkg.pricePerMember ||
    value.depositPercent !== depositPercent ||
    value.holdHours !== holdHours ||
    value.detailsVersion !== (pkg.detailsVersion ?? 0) ||
    (pkg.updatedAt && value.updatedAt !== new Date(pkg.updatedAt).toISOString())
  )
    throw new WorkflowProblem(
      409,
      'Thông tin gói đã thay đổi. Hãy tải lại, kiểm tra giá và xác nhận lại.',
    );
  if (
    !Number.isSafeInteger(depositPercent) ||
    depositPercent < 1 ||
    depositPercent > 100 ||
    !Number.isSafeInteger(holdHours) ||
    holdHours < 1 ||
    holdHours > 168
  )
    throw new WorkflowProblem(400, 'Cấu hình tiền cọc của gói không hợp lệ.');
  if (vietnamDay(start).getTime() !== vietnamDay(end).getTime())
    throw new WorkflowProblem(
      400,
      'Đơn theo gói cần có giờ bắt đầu và kết thúc trong cùng một ngày.',
    );
  if (
    start.getUTCSeconds() ||
    end.getUTCSeconds() ||
    start.getUTCMilliseconds() ||
    end.getUTCMilliseconds()
  )
    throw new WorkflowProblem(400, 'Chọn giờ chụp chính xác đến phút.');
  const total = pkg.pricePerMember * members;
  if (!Number.isSafeInteger(total) || total > 1_000_000_000_000)
    throw new WorkflowProblem(400, 'Tổng tiền gói vượt giới hạn cho phép.');
  const details = pkg.details ?? {};
  return {
    version: 1,
    total,
    depositRequired: Math.ceil((total * depositPercent) / 100),
    depositPercent,
    holdHours,
    detailsVersion: pkg.detailsVersion ?? 0,
    acceptedAt: new Date(),
    terms: [
      `Giá gói ${pkg.pricePerMember.toLocaleString('vi-VN')} đ/người × ${members} thành viên.`,
      `Đặt cọc ${depositPercent}%; giữ lịch ${holdHours} giờ sau khi studio duyệt, tối đa đến giờ chụp.`,
      'Hết hạn chưa đủ cọc: tự hủy, giải phóng lịch và hoàn lại số tiền đã ghi nhận theo đối soát.',
      ...[
        'deliverables',
        'shootScope',
        'pricingConditions',
        'depositPolicy',
        'cancellationPolicy',
        'priceNotes',
      ].flatMap((key) => (details[key]?.trim() ? [details[key].trim()] : [])),
    ],
    editingTerms: [
      pkg.editingScope === 'partial' ? 'Hậu kỳ ảnh chọn lọc' : 'Hậu kỳ toàn bộ ảnh đạt chất lượng',
    ],
  };
}
