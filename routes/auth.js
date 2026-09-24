const { Router } = require('express');
const { check } = require('express-validator');
const { login, googleSignin } = require('../controllers/auth');
const { validarCampos, authLimiter } = require('../middlewares');

const router = Router();


router.post('/login', [
    authLimiter,
    check('email','The email is required').isEmail(),
    check('password','The password is required').not().isEmpty(),
    validarCampos
],  login );

router.post('/google',[
    authLimiter,
    check('id_token', 'The id token is required').not().isEmpty(),
    validarCampos
], googleSignin );


module.exports = router;