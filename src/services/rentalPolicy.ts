import { WorkflowProblem } from './workflowTransactions';
import { vietnamDay } from '../utils/rentalPeriod';
import { createHash } from 'crypto';

const setting = (key: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new WorkflowProblem(503, `Cấu hình ${key} không hợp lệ.`);
  return value;
};
export function rentalPolicy() {
  const holdMinutes = setting('RENTAL_HOLD_MINUTES', 15, 1, 120);
  const maxPending = setting('RENTAL_MAX_PENDING', 2, 1, 10);
  const leadHours = setting('RENTAL_MIN_LEAD_HOURS', 24, 0, 720);
  const turnaroundDays = setting('RENTAL_TURNAROUND_DAYS', 1, 0, 14);
  const openHour = setting('RENTAL_OPEN_HOUR', 9, 0, 23);
  const closeHour = setting('RENTAL_CLOSE_HOUR', 17, 1, 24);
  const closedWeekdays = (process.env.RENTAL_CLOSED_WEEKDAYS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number);
  if (
    closeHour <= openHour ||
    closedWeekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw new WorkflowProblem(503, 'Khung giờ/ngày phục vụ thuê không hợp lệ.');
  const terms = [
    'Tiền thuê tính theo ngày, gồm cả ngày nhận và ngày trả. Cọc bảo đảm tách riêng và được đối soát sau khi nhận trả.',
    `Trang phục được giữ tạm ${holdMinutes} phút. Chưa đủ cọc khi hết hạn: đơn hết hiệu lực, số tiền đã nhận được đối soát hoàn lại.`,
    'Sau khi studio ghi nhận bất kỳ khoản cọc/thanh toán nào, khách không được hủy hoặc đổi mẫu, size, số lượng, ngày nhận/trả hay gia hạn.',
    `Nhận và trả trong khung ${openHour}:00–${closeHour}:00 (giờ Việt Nam), vào ngày studio phục vụ. Đặt trước tối thiểu ${leadHours} giờ tính đến giờ mở cửa ngày nhận.`,
    'Trả muộn, hỏng hoặc mất được studio lập đối soát; phụ phí cần khách xác nhận. Nếu studio không thể giao đủ hàng, studio xử lý hoàn tiền; khách không bị buộc đổi mẫu.',
    'Chuyển khoản phải đúng mã đơn. Tiền thiếu, thừa, về muộn hoặc sai mã cần đối soát; không dùng ảnh chụp chuyển khoản để tự xác nhận thuê.',
  ];
  return {
    version:
      'rental-auto-v1-' +
      createHash('sha256')
        .update(
          JSON.stringify({
            holdMinutes,
            maxPending,
            leadHours,
            turnaroundDays,
            openHour,
            closeHour,
            closedWeekdays,
            terms,
          }),
        )
        .digest('hex')
        .slice(0, 12),
    holdMinutes,
    maxPending,
    leadHours,
    turnaroundDays,
    openHour,
    closeHour,
    closedWeekdays,
    terms,
  };
}
export function validateRentalServiceDates(
  period: { receiveDate: Date; returnDate: Date },
  now = new Date(),
) {
  const policy = rentalPolicy();
  const pickup = +vietnamDay(period.receiveDate) + policy.openHour * 3600000;
  if (pickup < +now + policy.leadHours * 3600000)
    throw new WorkflowProblem(
      409,
      `Cần đặt trước tối thiểu ${policy.leadHours} giờ so với giờ nhận.`,
    );
  for (const date of [period.receiveDate, period.returnDate]) {
    const weekday = new Date(+vietnamDay(date) + 7 * 3600000).getUTCDay();
    if (policy.closedWeekdays.includes(weekday))
      throw new WorkflowProblem(409, 'Ngày nhận/trả rơi vào ngày studio không phục vụ.');
  }
  return policy;
}
