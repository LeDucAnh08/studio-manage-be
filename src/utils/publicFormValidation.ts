const phonePattern = /^(?:0[1-9]\d{8}|\+84[1-9]\d{8})$/;
const isText = (value: unknown, max: number, required = false) =>
  (value === undefined && !required) ||
  (typeof value === 'string' && value.length <= max && (!required || !!value.trim()));
export function publicStudentError(body: Record<string, unknown>) {
  if (!isText(body.name, 100, true))
    return 'Họ tên phải có từ 1 đến 100 ký tự và không chỉ gồm khoảng trắng.';
  if (!['male', 'female', 'other'].includes(String(body.gender)))
    return 'Vui lòng chọn giới tính hợp lệ.';
  for (const [key, label, min, max] of [
    ['height', 'Chiều cao', 50, 250],
    ['weight', 'Cân nặng', 10, 200],
  ] as const) {
    const value = body[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      return `${label} phải từ ${min} đến ${max} ${key === 'height' ? 'cm' : 'kg'}.`;
  }
  if (!isText(body.notes, 2000)) return 'Ghi chú tối đa 2.000 ký tự.';
  if (
    body.costumes !== undefined &&
    (!Array.isArray(body.costumes) ||
      body.costumes.length > 100 ||
      body.costumes.some((id) => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)))
  )
    return 'Danh sách trang phục không hợp lệ. Vui lòng tải lại biểu mẫu.';
}
export function publicFeedbackError(body: Record<string, unknown>) {
  for (const [key, label] of [
    ['crewFeedback', 'ekip'],
    ['albumFeedback', 'album'],
  ] as const) {
    const row = body[key] as { rating?: unknown; description?: unknown } | undefined;
    if (
      !row ||
      typeof row !== 'object' ||
      !Number.isInteger(row.rating) ||
      Number(row.rating) < 1 ||
      Number(row.rating) > 5
    )
      return `Vui lòng chọn từ 1 đến 5 sao cho ${label}.`;
    if (!isText(row.description, 2000, true))
      return `Nhận xét về ${label} phải có từ 1 đến 2.000 ký tự.`;
  }
  if (
    !isText(body.phone, 25) ||
    (typeof body.phone === 'string' &&
      body.phone.trim() &&
      !phonePattern.test(body.phone.trim().replace(/[ ().-]/g, '')))
  )
    return 'Số điện thoại phải gồm 10 chữ số bắt đầu bằng 0 hoặc dạng +84.';
  if (!isText(body.content, 4000)) return 'Cảm nhận tối đa 4.000 ký tự.';
  if (!isText(body.suggestion, 4000)) return 'Đề xuất tối đa 4.000 ký tự.';
}
