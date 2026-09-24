

const dbValidators = require('./db-validators');
const generateJWT  = require('./generar-jwt');
const googleVerify = require('./google-verify');


module.exports = {
    ...dbValidators,
    ...generateJWT,
    ...googleVerify,
}