/**
 * Google Apps Script — Web App nhận webhook từ backend studio-manage.
 *
 * Khi BE tạo lịch chụp, nó POST tới URL Web App này. Script sẽ:
 *   1. Xác thực `secret` khớp Script Property "SECRET".
 *   2. Trong ROOT_FOLDER_ID: tìm-hoặc-tạo
 *      folder bộ ảnh con theo tên trường/lớp/ngày (đã tồn tại thì dùng lại, không
 *      tạo trùng).
 *   3. Trong Google Sheet (SHEET_ID): tìm (hoặc tạo) tab Lịch chụp. Tìm dòng
 *      theo scheduleId — đã có thì cập nhật dòng đó, chưa có thì thêm dòng mới.
 *   4. Trả JSON { ok, folderId, folderUrl }.
 *
 * Khi XOÁ lịch chụp (body.action === 'delete'): chuyển folder bộ ảnh vào thùng
 * rác (theo folderId) và xoá dòng tương ứng trong Sheet (theo scheduleId).
 *
 * ─── Cấu hình (Project Settings → Script Properties) ───
 *   SECRET          : chuỗi bí mật, trùng GAS_WEBHOOK_SECRET bên backend
 *   ROOT_FOLDER_ID  : ID folder gốc trên Drive (chứa các bộ ảnh)
 *   SHEET_ID        : ID Google Sheet quản lý
 *
 * ─── Deploy ───
 *   Deploy → New deployment → Type: Web app
 *     - Execute as: Me
 *     - Who has access: Anyone
 *   Copy "Web app URL" → dán vào GAS_WEBHOOK_URL bên backend .env
 *   (Mỗi lần sửa code phải tạo "New version" khi deploy thì mới có hiệu lực.)
 */

var HEADERS = [
  'Ngày tạo',
  'Trường',
  'Lớp',
  'Ngày chụp',
  'Giờ',
  'Địa điểm',
  'Thợ chính',
  'Thợ phụ',
  'Link folder',
  'Trạng thái',
  'Link hợp đồng',
  'scheduleId',
];

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();

    var secret = props.getProperty('SECRET');
    if (secret && body.secret !== secret) {
      return _json({ ok: false, error: 'unauthorized' });
    }

    var rootId = props.getProperty('ROOT_FOLDER_ID');
    var sheetId = props.getProperty('SHEET_ID');
    if (!rootId || !sheetId) {
      return _json({ ok: false, error: 'missing ROOT_FOLDER_ID or SHEET_ID' });
    }

    if (body.action === 'delete') {
      return _handleDelete(body, sheetId);
    }

    // Giữ dòng đã có ở tab cũ; lịch mới dùng tab Lịch chụp.
    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = _findScheduleSheet(ss, body.scheduleId) || ss.getSheetByName('Lịch chụp');
    if (!sheet) {
      sheet = ss.insertSheet('Lịch chụp');
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
    }

    // 3. Tìm dòng theo scheduleId → có thì cập nhật, chưa có thì thêm mới
    var scheduleId = body.scheduleId || '';
    var existingRow = scheduleId ? _findRowByScheduleId(sheet, scheduleId) : -1;
    var oldFolderUrl = existingRow > 0 ? sheet.getRange(existingRow, 9).getValue() : '';
    var oldFolderId = String(oldFolderUrl).match(/\/folders\/([a-zA-Z0-9_-]+)/);
    // Giữ nguyên folder của lịch cũ; chỉ đặt bộ ảnh mới trực tiếp trong folder gốc.
    var folder = oldFolderId
      ? DriveApp.getFolderById(oldFolderId[1])
      : _getOrCreateChildFolder(DriveApp.getFolderById(rootId), _buildFolderName(body));
    var folderId = folder.getId();
    var folderUrl = folder.getUrl();
    var createdAt =
      existingRow > 0 ? sheet.getRange(existingRow, 1).getValue() || new Date() : new Date();

    var rowValues = [
      createdAt,
      body.school || '',
      body.className || '',
      body.shootDate || '',
      body.startTime || '',
      body.location || '',
      body.leadPhotographer || '',
      (body.supportPhotographers || []).join(', '),
      folderUrl,
      body.status || '',
      body.contractUrl || '',
      scheduleId,
    ];

    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }

    return _json({ ok: true, folderId: folderId, folderUrl: folderUrl });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function _getOrCreateChildFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// Xoá khi nhận action 'delete': bỏ folder vào thùng rác + xoá dòng Sheet.
function _handleDelete(body, sheetId) {
  var trashedFolder = false;
  var deletedRow = false;

  // 1. Chuyển folder bộ ảnh vào thùng rác (theo folderId)
  if (body.folderId) {
    try {
      DriveApp.getFolderById(body.folderId).setTrashed(true);
      trashedFolder = true;
    } catch (err) {
      // folder không tồn tại / đã xoá → bỏ qua
    }
  }

  // 2. Tìm dòng theo scheduleId trên các tab, bao gồm dữ liệu cũ
  var scheduleId = body.scheduleId || '';
  if (scheduleId) {
    var ss = SpreadsheetApp.openById(sheetId);
    var sheet = _findScheduleSheet(ss, scheduleId);
    if (sheet) {
      var row = _findRowByScheduleId(sheet, scheduleId);
      if (row > 0) {
        sheet.deleteRow(row);
        deletedRow = true;
      }
    }
  }

  return _json({ ok: true, trashedFolder: trashedFolder, deletedRow: deletedRow });
}

function _findScheduleSheet(ss, scheduleId) {
  if (!scheduleId) return null;
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (_findRowByScheduleId(sheets[i], scheduleId) > 0) return sheets[i];
  }
  return null;
}

// Tìm dòng có scheduleId (cột cuối) khớp; trả về số dòng (1-based) hoặc -1.
function _findRowByScheduleId(sheet, scheduleId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1; // chỉ có header hoặc rỗng
  var col = HEADERS.length; // scheduleId là cột cuối cùng
  if (sheet.getRange(1, col).getValue() !== 'scheduleId') return -1;
  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(scheduleId)) {
      return i + 2; // +2 vì bắt đầu từ dòng 2
    }
  }
  return -1;
}

function _buildFolderName(body) {
  // Định dạng: "9/6/2026 - 9A1 THCS Xín Cái - Địa điểm"
  var classSchool = [body.className, body.school]
    .filter(function (p) {
      return p;
    })
    .join(' ');
  var parts = [body.shootDate, classSchool, body.location].filter(function (p) {
    return p;
  });
  return parts.join(' - ') || 'Bộ ảnh mới';
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
