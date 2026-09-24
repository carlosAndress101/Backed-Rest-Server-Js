/**
 * Jest global teardown (T1.4 regression suite).
 *
 * Stops the mongodb-memory-server started in globalSetup.js.
 */
module.exports = async () => {
  if (global.__MONGOD__) {
    await global.__MONGOD__.stop();
    global.__MONGOD__ = undefined;
  }
};
