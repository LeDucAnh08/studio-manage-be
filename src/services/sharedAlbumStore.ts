import mongoose from 'mongoose';

export const LEGACY_ALBUM_COLLECTIONS = [
  'bookingalbums',
  'conceptalbums',
  'bookingalbumphotos',
  'conceptphotos',
  'bookingdeliveryphotos',
] as const;

export async function assertSharedAlbumStore() {
  for (const name of LEGACY_ALBUM_COLLECTIONS) {
    if (await mongoose.connection.collection(name).findOne({}, { projection: { _id: 1 } }))
      throw new Error(
        'Album storage migration required: run migrate:albums -- --apply before starting API/worker',
      );
  }
}
