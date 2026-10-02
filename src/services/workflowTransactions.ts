import mongoose, { ClientSession } from 'mongoose';

export class WorkflowProblem extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorkflowProblem';
    this.status = status;
  }
}

const isTransactionUnavailable = (error: unknown): boolean => {
  const value = error as { codeName?: string; code?: number; message?: string };
  const message = value?.message ?? '';
  return (
    value?.codeName === 'IllegalOperation' ||
    value?.code === 20 ||
    /transaction numbers are only allowed|does not support retryable writes|replica set member or mongos/i.test(
      message,
    )
  );
};

export const withResourceTransaction = async <T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const locks = mongoose.connection.collection<{ _id: string }>('resourcelocks');
  // Ensure the shared lock exists before starting the transaction. This avoids
  // a first-use upsert race where two new transactions can both attempt to
  // create the singleton lock record.
  try {
    await locks.updateOne(
      { _id: 'studio-resources' },
      { $setOnInsert: { version: 0, createdAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 11000) throw error;
  }
  const session = await mongoose.startSession();
  try {
    let result: T;
    try {
      await session.withTransaction(async () => {
        // Every writer which can reserve, release, or change shared resources touches
        // this same document, so overlapping transactions cannot both commit from
        // a stale availability snapshot.
        await locks.updateOne({ _id: 'studio-resources' }, { $inc: { version: 1 } }, { session });
        result = await work(session);
      });
      return result!;
    } catch (error) {
      if (isTransactionUnavailable(error)) {
        throw new WorkflowProblem(
          503,
          'This operation needs MongoDB transactions. Enable a replica set or mongos, then retry.',
        );
      }
      throw error;
    }
  } finally {
    await session.endSession();
  }
};

export const workflowEnabled = (): boolean =>
  process.env.CLIENT_WORKFLOW_ENABLED?.toLowerCase() === 'true';
