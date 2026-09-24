
const { Router } = require('express');
const { check } = require('express-validator');


const { validarCampos, validarJWT, hasRole, esAdminRole, esAdminOrOwner } = require('../middlewares');
const { esRoleValido, emailExiste, existUserById } = require('../helpers/db-validators');

const { getUsers, postUser, putUser, deleteUser,
usuariosPatch } = require('../controllers/usuarios');

const router = Router();


router.get('/',[
    validarJWT,
    esAdminRole
], getUsers );

router.post('/',[
    check('name', 'The name is obligatory').not().isEmpty(),
    check('password', 'The password must be longer than 8 characters ').isLength({ min: 8 }),
    check('email', 'The email is not valid').isEmail(),
    check('email').custom( emailExiste ),
    validarCampos
], postUser );

router.put('/:id',[
    validarJWT,
    esAdminOrOwner,
    check('id', 'Not a valid ID').isMongoId(),
    check('id').custom( existUserById ),
    // role is only writable by an admin; for anyone else it is dropped, not validated
    check('role').optional()
        .if( (value, { req }) => req.user.role === 'ADMIN_ROLE' )
        .custom( esRoleValido ),
    validarCampos
],putUser );


router.delete('/:id',[
    validarJWT,
    //esAdminRole,
    hasRole('ADMIN_ROLE','VENTAS_ROLE'),
    check('id', 'Not a valid ID').isMongoId(),
    check('id').custom( existUserById ),
    validarCampos
],deleteUser );

router.patch('/', usuariosPatch );





module.exports = router;