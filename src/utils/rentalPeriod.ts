import { WorkflowProblem } from '../services/workflowTransactions';

const DAY = 86400000;
const VN_OFFSET = 7 * 60 * 60 * 1000;

export const vietnamDay = (value: Date | string): Date => {
  const time = new Date(value).getTime();
  return new Date(Math.floor((time + VN_OFFSET) / DAY) * DAY - VN_OFFSET);
};

const calendarDate = (value: unknown): Date => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new WorkflowProblem(400, 'Ngày nhận và ngày trả phải có định dạng YYYY-MM-DD.');
  const utc = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== value)
    throw new WorkflowProblem(400, 'Ngày nhận hoặc ngày trả không hợp lệ.');
  return new Date(utc.getTime() - VN_OFFSET);
};

export const rentalDays = (receive: Date | string, returned: Date | string): number => {
  const start =
    typeof receive === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(receive)
      ? calendarDate(receive)
      : vietnamDay(receive);
  const end =
    typeof returned === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(returned)
      ? calendarDate(returned)
      : vietnamDay(returned);
  const days = (end.getTime() - start.getTime()) / DAY + 1;
  if (!Number.isSafeInteger(days) || days < 1)
    throw new WorkflowProblem(400, 'Ngày trả phải từ ngày nhận trở đi.');
  return days;
};

export const readRentalPeriod = (receive: unknown, returned: unknown, future = true) => {
  const receiveDate = calendarDate(receive);
  const returnDate = calendarDate(returned);
  const days = rentalDays(receiveDate, returnDate);
  if (future && receiveDate < vietnamDay(new Date()))
    throw new WorkflowProblem(400, 'Ngày nhận phải từ hôm nay.');
  if (days > 366) throw new WorkflowProblem(400, 'Kỳ thuê không được quá 366 ngày.');
  return { receiveDate, returnDate, rentalDays: days };
};
