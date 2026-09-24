const { request, response } = require("express");
const { Product } = require("../models");

//product obtained
const getProducts = async (req, res = response, next) => {
  // integers only, limit capped at 50 (limit 0 would mean "no limit" to Mongo)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const query = { state: true };

  try {
    const [total, products] = await Promise.all([
      Product.countDocuments(query),
      Product.find(query).skip(offset).limit(limit).populate('user','name')
    ]);       

    res.status(201).json({
      total,
      products
    });
  } catch (error) {
    next(error);
  }
};

//product obtained by id
const getProductId = async (req, res = response, next) => {
    const { id } = req.params;
  try {
    const product = await Product.findById(id).populate('user', 'name').populate('category','name')

    res.status(201).json({
      product
    });

  } catch (error) {
    next(error);
  }
};

//create product
const createProduct = async (req = request, res = response, next) => {
  const { state, user, ...body } = req.body;

  try {
    const name = body.name.toUpperCase();

    const productDB = await Product.findOne({ name });
    if (productDB) {
      return res.status(400).json({
        msg: `The ${productDB.name} product already exist`
      });
    }

    //generate data to saved
    const data = {
      ...body,
      name,
      user: req.user._id,
    };

    const product = new Product(data);
    await product.save();

    res.status(201).json(product);
  } catch (error) {
    next(error);
  }
};

const putProduct = async (req, res = response, next) => {
  const { id } = req.params;
  const {state, user, ...data } = req.body;

  //TODO validar contra base de datos
  try {
    if(data.name){
      data.name = data.name.toUpperCase();
    }

    data.user = req.user._id;

    const product = await Product.findByIdAndUpdate(id, data, {new: true});

    res.json(product);
  } catch (error) {
    next(error);
  }
};

const deleteProduct = async (req = request, res = response, next) => {
    const { id } = req.params;
    try {

        const productDelete = await Product.findByIdAndUpdate(id, {state: false}, {new: true});
        res.status(201).json(productDelete);

    } catch (error) {
        next(error);
    }
}

module.exports = {
  getProducts,
  getProductId,
  createProduct,
  putProduct,
  deleteProduct
};
