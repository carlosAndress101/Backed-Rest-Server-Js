const { Router } = require("express");
const { check } = require("express-validator");

const { validarJWT, esAdminRole } = require('../middlewares');
const {search} = require('../controllers/search');

const router = Router();

// searching users is private - admin only; the check runs on the decoded
// collection param so encoded variants (e.g. us%65r) can't skip it
const protectUserSearch = (req, res, next) => {
    if( req.params.collection !== 'user' ){
        return next();
    }

    validarJWT(req, res, () => esAdminRole(req, res, next));
}

router.get('/:collection/:term', protectUserSearch, search)




module.exports = router;
