const { Router } = require("express");
const { check } = require("express-validator");

const {
  validarCampos,
  validarJWT,
  esAdminRole
} = require("../middlewares");

const {
  getProducts,
  getProductId,
  createProduct,
  putProduct,
  deleteProduct
} = require('../controllers/product');

const { existProductById } = require("../helpers/db-validators");


const router = Router();

//get products - public
router.get("/",  getProducts);

//Get a product by id - public
router.get(
  "/:id",
  [
    check('id').custom( existProductById ),
    check("id", "Not a valid ID").isMongoId(),
    validarCampos
  ], getProductId)

//create a new product - private - anyone with a valid token
router.post(
  "/",
  [
    validarJWT,
    check("name", "Product name is required").not().isEmpty(),
    validarCampos
  ], createProduct
);

//Update a product - private - anyone with a valid token
router.put(
  "/:id",
  [
    validarJWT,
    esAdminRole,
    check('name','The name is required').not().isEmpty(),
    check('id').custom( existProductById ),
    check("id", "Not a valid ID").isMongoId(),
    validarCampos
  ], putProduct);

//Delete a product - private - admin
router.delete(
  "/:id",
  [
    validarJWT,
    esAdminRole,
    check('id').custom( existProductById ),
    check("id", "Not a valid ID").isMongoId(),
    validarCampos
  ], deleteProduct);

module.exports = router;
