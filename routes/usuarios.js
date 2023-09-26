
const { Router } = require('express');
const { check } = require('express-validator');


const { validarCampos, validarJWT, hasRole, esAdminRole } = require('../middlewares');
const { esRoleValido, emailExiste, existeUsuarioPorId } = require('../helpers/db-validators');

const { getUsers, postUser, putUser, deleteUser,
usuariosPatch } = require('../controllers/usuarios');

const router = Router();


router.get('/', getUsers );

router.post('/',[
    check('name', 'The name is obligatory').not().isEmpty(),
    check('password', 'The password must be longer than 8 characters ').isLength({ min: 8 }),
    check('email', 'The email is not valid').isEmail(),
    check('email').custom( emailExiste ),
    check('role').custom( esRoleValido ), 
    validarCampos
], postUser );

router.put('/:id',[
    check('id', 'Not a valid ID').isMongoId(),
    check('id').custom( existeUsuarioPorId ),
    check('role').custom( esRoleValido ), 
    validarCampos
],putUser );


router.delete('/:id',[
    validarJWT,
    //esAdminRole,
    hasRole('ADMIN_ROLE','VENTAS_ROLE'),
    check('id', 'Not a valid ID').isMongoId(),
    check('id').custom( existeUsuarioPorId ),
    validarCampos
],deleteUser );

router.patch('/', usuariosPatch );





module.exports = router;