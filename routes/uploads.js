const { Router } = require('express');
const { check } = require('express-validator');
const { validarCampos, fileValid } = require('../middlewares');
const { fileUpload, updateImage, showImage, updateImageCloudinary } = require('../controllers/uploads');
const { permittedCollections } = require('../helpers');

const router = Router();

router.post("/",fileValid, fileUpload);


/*
 *image upload to cloudinary 
 */
router.put("/:collection/:id", [
    fileValid,
    check('id','The id should be from mongo').isMongoId(),
    check("collection").custom( c => permittedCollections( c, ['user', 'product'])),
    validarCampos
], updateImageCloudinary);
//], updateImage);

router.get("/:collection/:id", [
    check('id','The id should be from mongo').isMongoId(),
    check("collection").custom( c => permittedCollections( c, ['user', 'product'])),
    validarCampos
], showImage)

module.exports = router;