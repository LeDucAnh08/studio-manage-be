import { Request, Response, NextFunction } from 'express';
import type { UserRole } from '../models/User';

export const requireRole = (...roles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.roles.some((r: number) => (roles as number[]).includes(r))) {
      res.status(403).json({ message: 'Forbidden: insufficient role' });
      return;
    }
    next();
  };
};
