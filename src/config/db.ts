import mongoose from 'mongoose';
import { ensureRoles } from '../services/roles';
import PackageDetail from '../models/PackageDetail';
import { assertSharedAlbumStore } from '../services/sharedAlbumStore';
import { assertConceptDetailStore } from '../services/conceptDetailStore';

const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(process.env.MONGO_URI as string);
    await assertSharedAlbumStore();
    await assertConceptDetailStore();
    await ensureRoles();
    await PackageDetail.init();
    console.log('MongoDB connected to database:', mongoose.connection.name);
  } catch (err) {
    console.error('MongoDB connection error:', (err as Error).message);
    process.exit(1);
  }
};

export default connectDB;
