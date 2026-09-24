// Migrated to TS in M3: src/modules/categories/category.model.ts is the sole registrant (ADR-027).
// Legacy consumers (models/index.js, helpers/db-validators.js, controllers/search.js) read it from the registry.
module.exports = require('mongoose').model('Category');
