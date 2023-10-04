
const validarCampos = require('../middlewares/validar-campos');
const validarJWT = require('../middlewares/validar-jwt');
const validarRole = require('../middlewares/validar-roles');
const fileValid = require('../middlewares/file-valid');

module.exports = {
    ...validarCampos,
    ...validarJWT,
    ...validarRole,
    ...fileValid
}