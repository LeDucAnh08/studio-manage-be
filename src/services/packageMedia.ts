import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { PackageImage } from '../types/packageContent';

export const packageMediaDirectory = () =>
  path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../../.data/package-media'));

export async function deletePackageImages(ids: string[]) {
  await Promise.all(
    ids
      .filter((id) => /^[a-f0-9-]{36}\.webp$/.test(id))
      .map(async (id) => {
        try {
          await unlink(path.join(packageMediaDirectory(), id));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Không xóa được ảnh gói:', id, error);
          }
        }
      }),
  );
}

export async function storePackageImage(file: Express.Multer.File): Promise<PackageImage> {
  let output: Buffer;
  try {
    const image = sharp(file.buffer, { limitInputPixels: 24_000_000, animated: false });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) {
      throw new Error('unsupported');
    }
    output = await image
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new Error('Ảnh không hợp lệ. Chỉ nhận ảnh JPEG, PNG, WebP tĩnh, tối đa 24 megapixel.');
  }
  const metadata = await sharp(output).metadata();
  const id = `${randomUUID()}.webp`;
  await mkdir(packageMediaDirectory(), { recursive: true });
  try {
    await writeFile(path.join(packageMediaDirectory(), id), output, { flag: 'wx' });
  } catch (error) {
    await deletePackageImages([id]);
    throw error;
  }
  return { id, alt: '', caption: '', width: metadata.width!, height: metadata.height! };
}
