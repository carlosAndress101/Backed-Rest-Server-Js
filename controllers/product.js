const { request, response } = require("express");
const { Product } = require("../models");

//product obtained
const getProducts = async (req, res = response) => {
  const { limit = 5, offset = 0 } = req.query;
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
    res.status(400).json({
      msg: "I can't get the products",
      error
    });
  }
};

//product obtained by id
const getProductId = async (req, res = response) => {
    const { id } = req.params;
  try {
    const product = await Product.findById(id).populate('user', 'name').populate('category','name')

    res.status(201).json({
      product
    });

  } catch (error) {
    res.status(400).json({
      msg: "I can't get the product",
      error
    });
  }
};

//create product
const createProduct = async (req = request, res = response) => {
  const { state, user, ...body } = req.body;

  const productDB = await Product.findOne({ name: body.name });
  if (productDB) {
    return res.status(400).json({
      msg: `The ${productDB.name} product already exist`
    });
  }

  //generate data to saved
  const data = {
    ...body,
    name: body.name.toUpperCase(),
    user: req.user._id,
   
  };

  const product = new Product(data);
  await product.save();

  res.status(201).json(product);
};

const putProduct = async (req, res = response) => {
  const { id } = req.params;
  const {state, user, ...data } = req.body;

  if(data.name){
    data.name = data.name.toUpperCase();
  }

  data.user = req.user._id;

  //TODO validar contra base de datos
  try {
    const product = await Product.findByIdAndUpdate(id, data, {new: true});

    res.json(product);
  } catch (error) {
    res.status(400).json(error.message);
  }
};

const deleteProduct = async (req = request, res = response) => {
    const { id } = req.params;
    try {

        const productDelete = await Product.findByIdAndUpdate(id, {state: false}, {new: true});
        res.status(201).json(productDelete);

    } catch (error) {
        res.status(400).json(error.message);
    }
}

module.exports = {
  getProducts,
  getProductId,
  createProduct,
  putProduct,
  deleteProduct
};
