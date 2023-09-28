const { Router } = require('express');
const { check } = require('express-validator');

const { validarCampos, validarJWT, hasRole, esAdminRole } = require('../middlewares');
const { esRoleValido, emailExiste, existeUsuarioPorId } = require('../helpers/db-validators');

const router = Router();


//get categorys - public
router.get('/', (req, res) => {
    res.json({
        msg:"All rigth"
    })
})

//Get a category by id - public
router.get('/:id', (req, res) => {
    res.json({
        msg:"All rigth get - id"
    })
})

//create a new category - private - anyone with a valid token 
router.post('/', (req, res) => {
    res.json({
        msg:"All rigth post"
    })
})

//Update a category - private - anyone with a valid token 
router.put('/:id', (req, res) => {
    res.json({
        msg:"All rigth put"
    })
})

//Delete a category - private - admin  
router.delete('/:id', (req, res) => {
    res.json({
        msg:"All rigth delete"
    })
})



module.exports = router;

