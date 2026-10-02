import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../..', '.env') });

import mongoose from 'mongoose';
import Transaction from '../models/Transaction';
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
  let totalSkipped = 0;

  for (const season of seasons) {
    console.log('🚀 ~ migrate ~ season:', season);
    const result = await Transaction.updateMany(
      {
        date: { $gte: season.startDate, $lte: season.endDate },
      },
      { $set: { season: season._id } },
    );
    console.log(`[${season.name}] Cập nhật ${result.modifiedCount} giao dịch`);
    totalUpdated += result.modifiedCount;
  }

  // Báo cáo giao dịch không khớp mùa nào
  const unmatched = await Transaction.countDocuments({ season: null });
  if (unmatched > 0) {
    console.log(`\n⚠️  ${unmatched} giao dịch không nằm trong mùa chụp nào (giữ season = null)`);
  }
  totalSkipped = unmatched;

  console.log(`\n✅ Hoàn tất: ${totalUpdated} giao dịch đã gán mùa, ${totalSkipped} bỏ qua`);

  await mongoose.disconnect();
  console.log('Disconnected');
};

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
