const { Category, Product, Role, User } = require('../models');

const esRoleValido = async(role = '') => {

    const existeRol = await Role.findOne({ role });
    if ( !existeRol ) {
        throw new Error(`El role ${ role } no está registrado en la BD`);
    }
}

const emailExiste = async( email = '' ) => {

    // Verificar si el correo existe
    const existeEmail = await User.findOne({ email });
    if ( existeEmail ) {
        throw new Error(`El correo: ${ email }, ya está registrado`);
    }
}

/**
 * Users
 */
const existUserById = async( id ) => {

    // Verificar si el correo existe
    const existUser = await User.findById(id);
    if ( !existUser ) {
        throw new Error(`The Id user not exist ${ id }`);
    }
}

/**
 * Categories
 */
const existCategoryById = async( id ) => {

    // Verify if Id exist
    const existCategory = await Category.findById(id);
    if ( !existCategory ) {
        throw new Error(`The id category not exist ${ id }`);
    }
}


/**
 * Products
 */
const existProductById = async( id ) => {

    // Verify if Id exist
    const existProduct = await Product.findById(id);
    if ( !existProduct ) {
        throw new Error(`The id product not exist ${ id }`);
    }
}

/**
 * Permitted Collection valid
 */
const permittedCollections = ( collection = '', collections = [] ) => {

    const include = collections.includes(collection);
    if( !include ) {
        throw new Error(`collection ${collection} is not permitted - ${collections}`);
    }

    return true;
} 



module.exports = {
    esRoleValido,
    emailExiste,
    existUserById,
    existCategoryById,
    existProductById,
    permittedCollections,
}

