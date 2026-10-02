import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../..', '.env') });

import mongoose from 'mongoose';
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

  let totalUpdated = 0;

  for (const season of seasons) {
    const result = await Schedule.updateMany(
      {
        shootDate: { $gte: season.startDate, $lte: season.endDate },
      },
      { $set: { season: season._id } },
    );
    console.log(`[${season.name}] Cập nhật ${result.modifiedCount} lịch chụp`);
    totalUpdated += result.modifiedCount;
  }

  // Báo cáo lịch chụp không khớp mùa nào
  const unmatched = await Schedule.countDocuments({
    $or: [{ season: null }, { season: { $exists: false } }],
  });
  if (unmatched > 0) {
    console.log(`\n⚠️  ${unmatched} lịch chụp không nằm trong mùa chụp nào (giữ season = null)`);
  }

  console.log(`\n✅ Hoàn tất: ${totalUpdated} lịch chụp đã gán mùa, ${unmatched} bỏ qua`);

  await mongoose.disconnect();
  console.log('Disconnected');
};

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
