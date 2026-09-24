const { rateLimit } = require('express-rate-limit');


// Shared by every auth route: 10 requests per IP per 15 minutes across the auth surface
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { msg: 'Too many requests, please try again later' }
});


module.exports = {
    authLimiter
}
