import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../..', '.env') });

import mongoose from 'mongoose';
import Customer from '../models/Customer';
import Schedule from '../models/Schedule';
import Season from '../models/Season';

const migrate = async (): Promise<void> => {
  await mongoose.connect(process.env.MONGO_URI_PROD as string);
  console.log('Connected to MongoDB', process.env.MONGO_URI_PROD);

  const seasons = await Season.find({}).sort({ startDate: 1 });
  if (seasons.length === 0) {
    console.log('Không có mùa chụp nào. Hãy tạo mùa chụp trước.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Tìm thấy ${seasons.length} mùa chụp:`);
  for (const s of seasons) {
    console.log(
      `  • ${s.name}: ${s.startDate.toISOString().slice(0, 10)} → ${s.endDate.toISOString().slice(0, 10)}`,
    );
  }

  // Lấy tất cả customer chưa có season
  const customers = await Customer.find({ season: null }).select('_id');
  console.log(`\nTìm thấy ${customers.length} lớp chưa được gán mùa chụp`);

  let updated = 0;
  let skipped = 0;

  for (const customer of customers) {
    // Lấy schedule đầu tiên của lớp (theo shootDate sớm nhất)
    const schedule = await Schedule.findOne({ customer: customer._id })
      .sort({ shootDate: 1 })
      .select('shootDate');

    if (!schedule) {
      skipped++;
      continue;
    }

    // Tìm mùa chứa ngày chụp
    const season = seasons.find(
      (s) => schedule.shootDate >= s.startDate && schedule.shootDate <= s.endDate,
    );

    if (!season) {
      skipped++;
      continue;
    }

    await Customer.updateOne({ _id: customer._id }, { $set: { season: season._id } });
    updated++;
  }

  console.log(
    `\n✅ Hoàn tất: ${updated} lớp đã gán mùa, ${skipped} bỏ qua (không có lịch chụp hoặc ngày chụp ngoài tất cả mùa)`,
  );

  await mongoose.disconnect();
  console.log('Disconnected');
};

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
