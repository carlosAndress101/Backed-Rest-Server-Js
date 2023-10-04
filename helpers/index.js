

const dbValidators = require('./db-validators');
const generateJWT  = require('./generar-jwt');
const googleVerify = require('./google-verify');
const uploadFile   = require('./upload-file');


module.exports = {
    ...dbValidators,
    ...generateJWT,
    ...googleVerify,
    ...uploadFile,
}