# Google Apps Script — Folder Drive & Sheet khi tạo lịch

Web App nhận webhook từ backend: mỗi khi tạo lịch chụp, BE gọi tới đây để tạo
folder Drive cho bộ ảnh và ghi 1 dòng vào Google Sheet quản lý nội bộ.

Cấu trúc dữ liệu:

- Drive: `<folder gốc>/<Ngày - Lớp Trường - Địa điểm>`, dùng lại folder đã có.
- Sheet: lịch mới dùng tab **Lịch chụp**. Dòng đã có ở tab cũ được tìm bằng `scheduleId` để cập nhật, không tạo trùng.
- Xóa lịch: chuyển đúng folder theo `folderId` vào thùng rác và tìm dòng theo `scheduleId` trên các tab để xóa. Các folder/tab cũ không bị di chuyển hoặc xóa hàng loạt.

## Thiết lập

1. Mở https://script.google.com → **New project**.
2. Dán toàn bộ nội dung [`Code.gs`](./Code.gs) vào, lưu lại.
3. **Project Settings → Script Properties**, thêm:
   | Key | Giá trị |
   |-----|---------|
   | `SECRET` | chuỗi bí mật bất kỳ (trùng `GAS_WEBHOOK_SECRET` trong backend `.env`) |
   | `ROOT_FOLDER_ID` | ID folder gốc trên Drive (chứa các bộ ảnh) |
   | `SHEET_ID` | ID Google Sheet quản lý (lấy từ URL sheet) |
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Authorize quyền truy cập Drive + Sheets khi được hỏi.
5. Copy **Web app URL** → dán vào backend `.env`:
   ```
   GAS_WEBHOOK_URL=<web app url>
   GAS_WEBHOOK_SECRET=<đúng chuỗi SECRET ở bước 3>
   ```

> Mỗi lần sửa `Code.gs` phải **Deploy → Manage deployments → New version** thì
> thay đổi mới có hiệu lực (URL giữ nguyên).

## Lấy ID

- **Folder ID**: mở folder trên Drive, URL dạng `drive.google.com/drive/folders/<FOLDER_ID>`.
- **Sheet ID**: mở Sheet, URL dạng `docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.

## Cột trong Sheet

`Ngày tạo | Trường | Lớp | Ngày chụp | Giờ | Địa điểm | Thợ chính | Thợ phụ | Link folder | Trạng thái | Link hợp đồng | scheduleId`

Tab Lịch chụp tự tạo header ở dòng đầu khi còn trống.

## Kiểm thử nhanh

Backend bỏ qua tích hợp này nếu `GAS_WEBHOOK_URL` rỗng (không lỗi). Sau khi cấu
hình, tạo 1 lịch chụp và kiểm tra: folder mới xuất hiện trong Drive, 1 dòng mới
trong Sheet, và field `driveFolderUrl` của lịch được cập nhật.
