/**
 * Shared helpers for the M1 security regression suite (T1.4).
 *
 * ARC-03: the application has a circular require
 *   models/index -> models/server -> routes/* -> controllers|helpers -> helpers/db-validators -> models/index
 * Entering the graph through `models/server` first is the only safe order. This
 * module requires it before touching `models/*`, and every test file requires
 * this module (or `../models/server`) before any other application module.
 */
require('../../models/server');

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const Server = require('../../models/server');
const connection = require('../../database/config');
const { generarJWT } = require('../../helpers/generar-jwt');
const User = require('../../models/user');
const Role = require('../../models/role');
const Category = require('../../models/category');
const Product = require('../../models/product');

// Cheap on purpose: bcrypt cost only has to be verifiable, not strong, in tests.
const BCRYPT_ROUNDS = 4;
const TEST_PASSWORD = 'test-password-123';

const uniqueSuffix = () => new mongoose.Types.ObjectId().toHexString();

/** Empties every collection so each test starts from a known state. */
const clearDatabase = async () => {
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
};

const hashPassword = (password = TEST_PASSWORD) => bcrypt.hashSync(password, BCRYPT_ROUNDS);

const createUser = async (overrides = {}) =>
  User.create({
    name: 'Test User',
    email: `user-${uniqueSuffix()}@example.com`,
    password: hashPassword(),
    role: 'USER_ROLE',
    state: true,
    ...overrides,
  });

const createAdmin = async (overrides = {}) =>
  createUser({ name: 'Admin User', role: 'ADMIN_ROLE', ...overrides });

const seedRoles = async (...roles) => {
  const wanted = roles.length ? roles : ['ADMIN_ROLE', 'USER_ROLE'];
  return Promise.all(wanted.map((role) => Role.create({ role })));
};

const createCategory = async (overrides = {}) => {
  const { user, ...rest } = overrides;
  const owner = user || (await createUser());
  return Category.create({
    name: `CATEGORY ${uniqueSuffix()}`,
    user: owner._id,
    ...rest,
  });
};

const createProduct = async (overrides = {}) => {
  const { user, category, ...rest } = overrides;
  const owner = user || (await createUser());
  const cat = category || (await createCategory({ user: owner }))._id;
  return Product.create({
    name: `PRODUCT ${uniqueSuffix()}`,
    user: owner._id,
    category: cat,
    ...rest,
  });
};

/** Mints a JWT for a user without going through the rate-limited login route. */
const tokenFor = (user) => generarJWT(user.id);

/** M1 still uses the custom `x-token` header (SEC-11 is a later milestone). */
const authHeader = (token) => ({ 'x-token': token });

const reload = (model, id) => model.findById(id);

/** Connects once per test file (C3: tests own the connection). */
const connectDatabase = async () => {
  if (mongoose.connection.readyState !== 0) {
    return;
  }

  // Jest runs test files in parallel workers against one mongod. Give every
  // file its own database so a `clearDatabase()` in one file cannot wipe
  // another file's fixtures mid-test.
  const base = (process.env.MONGO_CLOUD || '').replace(/\/+$/, '');
  const state = typeof expect !== 'undefined' && expect.getState ? expect.getState() : {};
  const file = state.testPath || `worker-${process.env.JEST_WORKER_ID || 0}`;
  const dbName = `m1_t14_${path.basename(file, '.e2e.js').replace(/[^a-z0-9_]/gi, '_')}`;
  process.env.MONGO_CLOUD = `${base}/${dbName}`;

  await connection();
};

// ---------------------------------------------------------------------------
// Serving the app (T1.8)
// ---------------------------------------------------------------------------

const servers = new Set();

/**
 * Serves an Express app on 127.0.0.1 and resolves to the listening server, which
 * the tests hand to SuperTest instead of the bare app.
 *
 * Given a bare app, SuperTest listens on an ephemeral port of the dual-stack
 * wildcard (::) and then connects to 127.0.0.1 on that port. macOS hands out such
 * ports even when another process listens on 127.0.0.1 with the same number, and
 * that more specific listener gets the connection: local services (an IDE helper,
 * a device agent, another run's mongod) answered test requests with their own
 * 401/403/501. Listening on 127.0.0.1 itself makes the port exclusively ours.
 *
 * Every response closes its connection, like SuperTest's per-request servers, so
 * no keep-alive socket is reused from one request or test to the next.
 */
const serve = async (app) => {
  const server = http.createServer((req, res) => {
    res.setHeader('Connection', 'close');
    app(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.add(server);
  return server;
};

/** C3: `new Server()` has no side effects; `server.app` is served by `serve()`. */
const buildApp = () => serve(new Server().app);

/** Closes every server this test file started. Call it from `afterAll`. */
const closeServers = async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
};

// ---------------------------------------------------------------------------
// Temporary upload files (express-fileupload useTempFiles)
// ---------------------------------------------------------------------------

const TMP_DIRS = [...new Set(['/tmp', os.tmpdir()].map((dir) => path.normalize(dir)))];

/**
 * Temp names are `tmp-<counter>-<pid><timestamp>` (express-fileupload). Filter
 * by our own pid so files written by parallel jest workers are ignored.
 *
 * C10: each upload request writes its temp files into its own
 * `upload-<pid>-<uuid>` folder, so a folder left behind is a leak too.
 */
const isOwnTempEntry = (name) =>
  (name.startsWith('tmp-') && name.includes(`-${process.pid}`)) ||
  name.startsWith(`upload-${process.pid}-`);

const listTempFiles = () => {
  const found = new Set();
  TMP_DIRS.forEach((dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (error) {
      entries = [];
    }
    entries.filter(isOwnTempEntry).forEach((name) => found.add(path.join(dir, name)));
  });
  return found;
};

const newTempFiles = (before) => {
  const after = listTempFiles();
  return [...after].filter((file) => !before.has(file));
};

/** Polls briefly so an awaited-but-async cleanup is not a race. */
const waitForNoTempLeak = async (before, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  let leaked = newTempFiles(before);
  while (leaked.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    leaked = newTempFiles(before);
  }
  return leaked;
};

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

const resetUploadDirs = () => {
  ['imgs', 'user', 'product'].forEach((folder) => {
    const dir = path.join(UPLOAD_DIR, folder);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};

module.exports = {
  BCRYPT_ROUNDS,
  TEST_PASSWORD,
  clearDatabase,
  hashPassword,
  connectDatabase,
  serve,
  buildApp,
  closeServers,
  createUser,
  createAdmin,
  seedRoles,
  createCategory,
  createProduct,
  tokenFor,
  authHeader,
  reload,
  listTempFiles,
  newTempFiles,
  waitForNoTempLeak,
  resetUploadDirs,
  uniqueSuffix,
  User,
  Role,
  Category,
  Product,
};
