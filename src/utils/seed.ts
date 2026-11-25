import path from 'path';
import dotenv from 'dotenv';

const envFile = process.env.NODE_ENV === 'production' ? '.env' : '.env';
dotenv.config({ path: path.join(__dirname, '../..', envFile) });

import mongoose from 'mongoose';
import User, { ACTIVE_ROLES } from '../models/User';
import Category from '../models/Category';

interface DefaultCategory {
  name: string;
  type: 'income' | 'expense';
  isDefault: boolean;
}

const defaultCategories: DefaultCategory[] = [
  { name: 'Đặt cọc', type: 'income', isDefault: true },
  { name: 'Thanh toán còn lại', type: 'income', isDefault: true },
  { name: 'In ấn / Album', type: 'expense', isDefault: true },
  { name: 'Nhân sự / Thợ chụp', type: 'expense', isDefault: true },
  { name: 'Thiết bị / Vật tư', type: 'expense', isDefault: true },
  { name: 'Khác', type: 'expense', isDefault: true },
];

const seed = async (): Promise<void> => {
  await mongoose.connect(process.env.MONGO_URI as string);
  console.log('🚀 ~ seed ~ process.env.MONGO_URI:', process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const username = process.env.SEED_ADMIN_USERNAME ?? 'superadmin';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@1234';

  // Migrate: convert old single 'role' field to 'roles' array
  const oldUsers = await User.collection
    .find({ role: { $in: ACTIVE_ROLES }, roles: { $exists: false } })
    .toArray();
  for (const u of oldUsers) {
    await User.collection.updateOne(
      { _id: u._id },
      { $set: { roles: [u.role] }, $unset: { role: '' } },
    );
    console.log(`Migrated "${u.username}": role ${u.role} → roles [${u.role}]`);
  }

  const existingAdmin = await User.findOne({ username });
  if (existingAdmin) {
    if (!existingAdmin.roles?.some((role) => role === 0 || role === 1))
      throw new Error('Tên tài khoản seed đã tồn tại ngoài nhóm quản trị; không tự nâng quyền.');
    if (!existingAdmin.roles?.includes(0)) {
      await User.updateOne({ username }, { roles: [0] });
      console.log(`Superadmin "${username}" roles migrated to [0].`);
    } else {
      console.log(`Superadmin "${username}" already exists.`);
    }
  } else {
    await User.create({ username, password, roles: [0] });
    console.log(`Superadmin "${username}" created with password "${password}"`);
  }

  for (const cat of defaultCategories) {
    const exists = await Category.findOne({ name: cat.name, type: cat.type });
    if (!exists) {
      await Category.create(cat);
      console.log(`Category created: ${cat.name} (${cat.type})`);
    }
  }

  console.log('Seeding complete.');
  process.exit(0);
};

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
