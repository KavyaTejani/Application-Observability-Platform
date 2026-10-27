import mongoose, { type Connection } from 'mongoose';
import type { Logger } from 'pino';

export async function connectMongo(uri: string, logger: Logger): Promise<Connection> {
  mongoose.set('strictQuery', true);
  const connection = mongoose.connection;
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('error', (err: Error) => logger.error({ err: err.message }, 'MongoDB error'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    // Fail fast on queries while disconnected rather than buffering them indefinitely.
    bufferCommands: false,
  });
  logger.info('MongoDB connected');
  return connection;
}

export async function pingMongo(connection: Connection): Promise<void> {
  if (!connection.db) throw new Error('MongoDB not connected');
  await connection.db.admin().ping();
}
