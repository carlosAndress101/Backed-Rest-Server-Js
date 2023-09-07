const { Router } = require('express');
const { check } = require('express-validator');
const { login } = require('../controllers/auth');
const { validarCampos } = require('../middlewares/validar-campos');

const router = Router();


router.post('/login', [
    check('email','The email is required').isEmail(),
    check('password','The password is required').not().isEmpty(),
    validarCampos
],  login );


module.exports = router;