import type { RequestHandler } from 'express';

const isEnabled = (value: string | undefined): boolean => value?.toLowerCase() !== 'false';

export const requireClientPortal: RequestHandler = (_req, res, next) => {
  if (!isEnabled(process.env.CLIENT_PORTAL_ENABLED)) {
    res.status(503).json({
      success: false,
      message: 'Cổng khách hàng đang tạm ngưng. Vui lòng liên hệ studio.',
      data: null,
    });
    return;
  }
  next();
};
