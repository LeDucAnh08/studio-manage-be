/**
 * copyProdToLocal.ts
 * Sao chép toàn bộ dữ liệu từ MongoDB production sang MongoDB local/atlas.
 *
 * Cách dùng:
 *   npm run copy:prod-to-local
 *   # hoặc
 *   ts-node src/utils/copyProdToLocal.ts
 *
 * Biến môi trường cần có trong .env:
 *   MONGO_URI_PROD  – chuỗi kết nối production
 *   MONGO_URI       – chuỗi kết nối local / atlas
 */

import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../..', '.env') });

import mongoose, { Connection } from 'mongoose';

// ─── Danh sách collection cần sao chép (theo thứ tự phụ thuộc) ───────────────
const COLLECTIONS = [
  'seasons',
  'users',
  'costumes',
  'costumtypes', // mongoose pluralises CostumeType → costumtypes
  'costumetypes', // phòng trường hợp tên khác
  'categories',
  'packages',
  'customers',
  'schedules',
  'students',
  'transactions',
  'feedbacks',
];

async function openConnection(uri: string, label: string): Promise<Connection> {
  const conn = mongoose.createConnection(uri);
  await conn.asPromise();
  console.log(`✅ [${label}] Kết nối thành công`);
  return conn;
}

async function copyCollection(src: Connection, dst: Connection, name: string): Promise<void> {
  const srcCol = src.collection(name);
  const dstCol = dst.collection(name);

  const total = await srcCol.countDocuments();
  if (total === 0) {
    console.log(`   ⚪ ${name}: rỗng, bỏ qua`);
    return;
  }

  const docs = await srcCol.find({}).toArray();

  // Xoá sạch collection đích rồi insert mới để đảm bảo đồng bộ
  await dstCol.deleteMany({});
  await dstCol.insertMany(docs, { ordered: false });

  console.log(`   ✅ ${name}: sao chép ${docs.length} document`);
}

async function main(): Promise<void> {
  const prodUri = process.env.MONGO_URI_PROD;
  const localUri = process.env.MONGO_URI;

  if (!prodUri) {
    console.error('❌ Thiếu biến môi trường MONGO_URI_PROD');
    process.exit(1);
  }
  if (!localUri) {
    console.error('❌ Thiếu biến môi trường MONGO_URI');
    process.exit(1);
  }

  console.log('\n🚀 Bắt đầu sao chép dữ liệu production → local\n');

  const prod = await openConnection(prodUri, 'PROD');
  const local = await openConnection(localUri, 'LOCAL');

  // Lấy danh sách collection thực tế từ prod (bao gồm cả collection ngoài danh sách cứng)
  const prodCollections = (await prod.db!.listCollections().toArray()).map((c) => c.name);
  console.log(`\n📦 Collection tìm thấy trên PROD: ${prodCollections.join(', ')}\n`);

  // Gộp: ưu tiên thứ tự từ COLLECTIONS, thêm phần còn lại ở cuối
  const ordered = [
    ...COLLECTIONS.filter((c) => prodCollections.includes(c)),
    ...prodCollections.filter((c) => !COLLECTIONS.includes(c)),
  ];

  for (const name of ordered) {
    try {
      await copyCollection(prod, local, name);
    } catch (err) {
      console.error(`   ❌ ${name}: lỗi –`, err instanceof Error ? err.message : err);
    }
  }

  await prod.close();
  await local.close();

  console.log('\n🎉 Hoàn tất sao chép dữ liệu!\n');
}

main().catch((err) => {
  console.error('Lỗi không xử lý được:', err);
  process.exit(1);
});
