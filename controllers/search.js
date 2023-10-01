const { response } = require("express");
const { User, Category, Product } = require("../models/index");
const { isValidObjectId } = require("mongoose");


const permittedCollections = [
    'user',
    'category',
    'product',
    'role'
];

//searching users
const SearchUser = async ( term = '', res = response ) => {
    const isMongoID = isValidObjectId( term ); //true

    if( isMongoID ){
        const user = await User.findById( term );
        return res.json({
            results: ( user.state ) ? [ user ] : []
        })
    }

    const regex = new RegExp( term, 'i');
    const users = await User.find({ 
        $or: [{ name: regex}, {email: regex}],
        $and: [{state: true}]
     });

    res.json({
        results: users
    })
}

//searching categories
const SearchCategory = async ( term = '', res = response ) => {
    const isMongoID = isValidObjectId( term ); //true

    if( isMongoID ){
        const category = await Category.findById( term );
        return res.json({
            results: ( category.state  ) ? [ category ] : []
        })
    }

    const regex = new RegExp( term, 'i');
    const categories = await Category.find({ 
        $or: [{ name: regex}],
        $and: [{state: true}]
     });

    res.json({
        results: categories
    })
}

//searching products
const SearchProduct = async ( term = '', res = response ) => {
    const isMongoID = isValidObjectId( term ); //true

    if( isMongoID ){
        const product = await Product.findById( term ).populate('category','name');
        return res.json({
            results: ( product.state ) ? [ product ] : []
        })
    }

    const regex = new RegExp( term, 'i');
    const products = await Product.find({ 
        $or: [{ name: regex}, {description: regex}],
        $and: [{state: true}]
     });

    res.json({
        results: products
    })
}

//function
const search = async (req, res = response) => {

    const {collection, term} = req.params;

    if( !permittedCollections.includes(collection)){
        return res.status(400).json({
            msg:`The permitted collections are: ${permittedCollections}`
        })
    }

    switch (collection) {
        case 'user':
            SearchUser(term, res);
        break;
    
        case 'category':
            SearchCategory(term, res);
        break;
    
        case 'product':
            SearchProduct(term, res);
        break;
    
        default:
            res.status(500).json({
                msg: 'Forgot to do this search'
            })
        break;
    }
 
}

module.exports = {
    search
}