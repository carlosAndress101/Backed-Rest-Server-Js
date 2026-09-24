// Migrated to TS in M3: src/modules/users/user.model.ts is the sole registrant (ADR-027).
// Legacy consumers (models/index.js, helpers/db-validators.js, middlewares/validar-jwt.js and the auth, search and
// uploads controllers) read it from the registry.
module.exports = require('mongoose').model('User');
