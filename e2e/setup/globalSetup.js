/**
 * Jest global setup (T1.4 regression suite).
 *
 * Starts a single mongodb-memory-server for the whole run and publishes the
 * connection parameters through process.env. Test workers are forked after this
 * hook, so they inherit these values and no test file binds a port.
 *
 * ARC-03 note: nothing here may require `models/**`; only the memory server.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async () => {
  const mongod = await MongoMemoryServer.create();

  process.env.MONGO_CLOUD = mongod.getUri();
  process.env.SECRET_KEY = 'm1-t14-regression-secret';
  // A well-formed placeholder so cloudinary.config() never sees undefined.
  process.env.CLOUDINARY_URL = 'cloudinary://key:secret@demo';
  process.env.GOOGLE_CLIENT_ID = 'm1-t14-test-client-id';

  global.__MONGOD__ = mongod;
};
