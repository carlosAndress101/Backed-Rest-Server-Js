const { Router } = require("express");
const { check } = require("express-validator");

const {
  validarCampos,
  validarJWT,
  esAdminRole
} = require("../middlewares");

const { existCategoryById } = require("../helpers/db-validators");

const {
  createCategory,
  getCategory,
  getCategoryId,
  putCategory,
  deleteCategory
} = require("../controllers/category");

const router = Router();

//get categorys - public
router.get("/", getCategory);

//Get a category by id - public
router.get(
  "/:id",
  [
    check('id').custom( existCategoryById ),
    check("id", "Not a valid ID").isMongoId(),
    validarCampos
  ],
  getCategoryId
);

//create a new category - private - anyone with a valid token
router.post(
  "/",
  [
    validarJWT,
    check("name", "Category name is required").not().isEmpty(),
    validarCampos
  ],
  createCategory
);

//Update a category - private - anyone with a valid token
router.put(
  "/:id",
  [
    validarJWT,
    esAdminRole,
    check('name','The name is required').not().isEmpty(),
    check('id').custom( existCategoryById ),
    check("id", "Not a valid ID").isMongoId(),
    validarCampos
  ],
  putCategory
);

//Delete a category - private - admin
router.delete(
  "/:id",
  [
    validarJWT,
    esAdminRole,
    check('id').custom( existCategoryById ),
    check("id", "Not a valid ID").isMongoId(),
    validarCampos
  ],
  deleteCategory
);

module.exports = router;
