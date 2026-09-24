const { Router } = require('express');
const { check } = require('express-validator');
const { validarCampos, validarJWT, esAdminRole, esAdminOrOwner, fileParser, fileValid } = require('../middlewares');
const { fileUpload, updateImage, showImage, updateImageCloudinary } = require('../controllers/uploads');
const { permittedCollections } = require('../helpers');

const router = Router();

router.post("/", [
    validarJWT,
    esAdminRole,
    fileParser,
    fileValid
], fileUpload);


/*
 *image upload to cloudinary 
 */
router.put("/:collection/:id", [
    validarJWT,
    esAdminOrOwner,
    check('id','The id should be from mongo').isMongoId(),
    check("collection").custom( c => permittedCollections( c, ['user', 'product'])),
    validarCampos,
    fileParser,
    fileValid
], updateImageCloudinary);
//], updateImage);

router.get("/:collection/:id", [
    check('id','The id should be from mongo').isMongoId(),
    check("collection").custom( c => permittedCollections( c, ['user', 'product'])),
    validarCampos
], showImage)

module.exports = router;