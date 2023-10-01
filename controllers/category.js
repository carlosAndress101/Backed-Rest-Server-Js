const { request, response } = require("express");
const { Category } = require("../models");

//category obtained
const getCategory = async (req, res = response) => {
  const { limit = 5, offset = 0 } = req.query;
  const query = { state: true };

  try {
    const [total, categories] = await Promise.all([
      Category.countDocuments(query),
      Category.find(query).skip(offset).limit(limit).populate('user','name')
    ]);

    res.status(201).json({
      total,
      categories
    });
  } catch (error) {
    res.status(400).json({
      msg: "I can't get the categories",
      error
    });
  }
};

const getCategoryId = async (req, res = response) => {
    const { id } = req.params;
  try {
    const categories = await Category.findById(id).populate('user', 'name')

    res.status(201).json({
      categories
    });
  } catch (error) {
    res.status(400).json({
      msg: "I can't get the category",
      error
    });
  }
};

//create category
const createCategory = async (req = request, res = response) => {
  const name = req.body.name.toUpperCase();

  const categoryDB = await Category.findOne({ name });
  if (categoryDB) {
    return res.status(400).json({
      msg: `The ${categoryDB.name} category already exist`
    });
  }

  //generate data to saved

  const data = {
    name: name,
    user: req.user._id
  };

  const category = new Category(data);
  await category.save();

  res.status(201).json(category);
};

const putCategory = async (req, res = response) => {
  const { id } = req.params;
  const {state, user, ...data } = req.body;

  data.name = data.name.toUpperCase();
  data.user = req.user._id;

  //TODO validar contra base de datos
  try {
    const categories = await Category.findByIdAndUpdate(id, data, {new: true});

    res.json(categories);
  } catch (error) {
    res.status(400).json(error.message);
  }
};

const deleteCategory = async (req = request, res = response) => {
    const { id } = req.params;
    try {
        const categoryDelete = await Category.findByIdAndUpdate(id, {state: false}, {new: true});
        res.status(201).json(categoryDelete);
    } catch (error) {
        res.status(400).json(error.message);
    }
}
module.exports = {
  createCategory,
  getCategory,
  getCategoryId,
  putCategory,
  deleteCategory
};
