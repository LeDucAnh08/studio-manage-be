import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import connectDB from './config/db';
import authRoutes from './routes/auth';
import categoryRoutes from './routes/categories';
import costumeRoutes from './routes/costumes';
import costumeTypeRoutes from './routes/costumeTypes';
import customerRoutes from './routes/customers';
import feedbackRoutes from './routes/feedbacks';
import packageRoutes from './routes/packages';
import publicRoutes from './routes/public';
import scheduleRoutes from './routes/schedules';
import studentRoutes from './routes/students';
import transactionRoutes from './routes/transactions';
import userRoutes from './routes/users';
import telegramRoutes from './routes/telegram';
import seasonController from './routes/season';
import dashboardRoutes from './routes/dashboard';
import accountRequestRoutes from './routes/accountRequests';
import bookingRoutes from './routes/bookings';
import workflowRoutes from './routes/workflows';
import rentalRoutes from './routes/rentals';
import reportRoutes from './routes/reports';

const envFile = '.env';
dotenv.config({ path: path.resolve(__dirname, '..', envFile) });

const app = express();

const corsOrigin = process.env.CORS_ORIGIN;
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(
  cors(
    corsOrigin
      ? { origin: corsOrigin.split(',').map((origin) => origin.trim()), credentials: true }
      : process.env.NODE_ENV === 'production'
        ? { origin: false }
        : undefined,
  ),
);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '100kb' }));

app.use('/api/auth', authRoutes);
app.use('/api/account-requests', accountRequestRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/rentals', rentalRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/users', userRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/costumes', costumeRoutes);
app.use('/api/costume-types', costumeTypeRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/feedbacks', feedbackRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/seasons', seasonController);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = Number(process.env.PORT) || 5000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});

export default app;
