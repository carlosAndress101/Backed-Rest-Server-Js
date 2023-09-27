const { Router } = require('express');
const { check } = require('express-validator');
const { login, googleSignin } = require('../controllers/auth');
const { validarCampos } = require('../middlewares/validar-campos');

const router = Router();


router.post('/login', [
    check('email','The email is required').isEmail(),
    check('password','The password is required').not().isEmpty(),
    validarCampos
],  login );

router.post('/google',[
    check('id_token', 'The id token is required').not().isEmpty(),
    validarCampos
], googleSignin );


module.exports = router;