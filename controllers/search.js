const { response } = require("express");
const { User, Category, Product } = require("../models/index");
const { isObjectIdOrHexString } = require("mongoose");


const permittedCollections = [
    'user',
    'category',
    'product'
];

const MAX_RESULTS = 20;

// escape regex metacharacters so the term is matched literally
const escapeRegex = ( term = '' ) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

//searching users
const SearchUser = async ( term = '', res = response ) => {
    const isMongoID = isObjectIdOrHexString( term ); //true

    if( isMongoID ){
        const user = await User.findById( term );
        return res.json({
            results: ( user?.state ) ? [ user ] : []
        })
    }

    const regex = new RegExp( escapeRegex( term ), 'i');
    const users = await User.find({ 
        $or: [{ name: regex}, {email: regex}],
        $and: [{state: true}]
     }).limit( MAX_RESULTS );

    res.json({
        results: users
    })
}

//searching categories
const SearchCategory = async ( term = '', res = response ) => {
    const isMongoID = isObjectIdOrHexString( term ); //true

    if( isMongoID ){
        const category = await Category.findById( term );
        return res.json({
            results: ( category?.state ) ? [ category ] : []
        })
    }

    const regex = new RegExp( escapeRegex( term ), 'i');
    const categories = await Category.find({ 
        $or: [{ name: regex}],
        $and: [{state: true}]
     }).limit( MAX_RESULTS );

    res.json({
        results: categories
    })
}

//searching products
const SearchProduct = async ( term = '', res = response ) => {
    const isMongoID = isObjectIdOrHexString( term ); //true

    if( isMongoID ){
        const product = await Product.findById( term ).populate('category','name');
        return res.json({
            results: ( product?.state ) ? [ product ] : []
        })
    }

    const regex = new RegExp( escapeRegex( term ), 'i');
    const products = await Product.find({ 
        $or: [{ name: regex}, {description: regex}],
        $and: [{state: true}]
     }).limit( MAX_RESULTS );

    res.json({
        results: products
    })
}

//function
const search = async (req, res = response, next) => {

    const {collection, term} = req.params;

    if( !permittedCollections.includes(collection)){
        return res.status(400).json({
            msg:`The permitted collections are: ${permittedCollections}`
        })
    }

    try {
        switch (collection) {
            case 'user':
                await SearchUser(term, res);
            break;
        
            case 'category':
                await SearchCategory(term, res);
            break;
        
            case 'product':
                await SearchProduct(term, res);
            break;
        
            default:
                res.status(500).json({
                    msg: 'Forgot to do this search'
                })
            break;
        }
    } catch (error) {
        next(error);
    }
}

module.exports = {
    search
}