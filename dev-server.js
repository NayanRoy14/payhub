/**
 * Throwaway local dev bootstrap: spins up MongoDB and Redis (falling back to
 * in-memory/local portable servers if MONGODB_URI/REDIS_URL aren't set to a
 * real external instance) and starts the PayHub app + BullMQ verification
 * worker on top of them. Not part of the deployable app — safe to delete.
 */
require('dotenv').config();

// This machine's default DNS resolver doesn't answer Node's SRV lookups
// correctly (needed for mongodb+srv:// Atlas URIs), even though it resolves
// fine via the OS resolver. Public DNS works around it. This is a local
// network quirk, not something the deployable app needs.
if (process.env.MONGODB_URI && process.env.MONGODB_URI.includes('mongodb+srv')) {
  require('dns').setServers(['8.8.8.8', '1.1.1.1']);
}

const { MongoMemoryServer } = require('mongodb-memory-server');
const { RedisMemoryServer } = require('redis-memory-server');
const { connectDb } = require('./dist/db/connection');
const { createApp } = require('./dist/server');
const { startVerificationWorker, scheduleVerification } = require('./dist/queue/retryQueue');

const USE_REAL_MONGO = !!process.env.MONGODB_URI && process.env.MONGODB_URI.includes('mongodb+srv');
const USE_REAL_REDIS =
  !!process.env.REDIS_URL && !process.env.REDIS_URL.includes('127.0.0.1') && !process.env.REDIS_URL.includes('localhost');

(async () => {
  let mongoUri = process.env.MONGODB_URI;
  if (!USE_REAL_MONGO) {
    const mongod = await MongoMemoryServer.create();
    mongoUri = mongod.getUri();
  }
  await connectDb(mongoUri);

  if (!USE_REAL_REDIS) {
    const redisServer = new RedisMemoryServer();
    const host = await redisServer.getHost();
    const port = await redisServer.getPort();
    process.env.REDIS_URL = `redis://${host}:${port}`;
  }

  const worker = startVerificationWorker(async (data) => {
    console.log(`[retryQueue] verification job processed:`, data);
  });
  worker.on('error', (err) => console.error('[retryQueue] worker error', err));

  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`PayHub dev server listening on http://localhost:${port}`);
    console.log(`Mongo: ${USE_REAL_MONGO ? 'real (Atlas)' : 'in-memory'} -> ${mongoUri}`);
    console.log(`Redis: ${USE_REAL_REDIS ? 'real (external)' : 'local portable'} -> ${process.env.REDIS_URL}`);
  });
})().catch((err) => {
  console.error('Failed to start dev server', err);
  process.exit(1);
});
