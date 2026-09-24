
const validarCampos = require('../middlewares/validar-campos');
const validarJWT = require('../middlewares/validar-jwt');
const validarRole = require('../middlewares/validar-roles');
const fileValid = require('../middlewares/file-valid');
const rateLimit = require('../middlewares/rate-limit');

module.exports = {
    ...validarCampos,
    ...validarJWT,
    ...validarRole,
    ...fileValid,
    ...rateLimit
}