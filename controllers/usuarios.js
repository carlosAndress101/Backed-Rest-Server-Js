const { response, request } = require("express");
const bcrypt = require("bcrypt");

const User = require("../models/user");

const getUsers = async (req = request, res = response, next) => {
  const { limit = 5, offset = 0 } = req.query;
  const query = { state: true };

  try {
    const [total, user] = await Promise.all([
      User.countDocuments(query),
      User.find(query).skip(offset).limit(limit),
    ]);

    res.json({
      total,
      user,
    });
  } catch (error) {
    next(error);
  }
};

const postUser = async (req = request, res = response, next) => {
  const { name, email, password } = req.body;
  try {
    //Encript password
    const passHash = await bcrypt.hash(password, 10);
    // sign-up never takes a role from the client
    const newUser = new User({ name, email, password: passHash, role: "USER_ROLE" });

    //save DB
    await newUser.save();
    res.json(newUser);
  } catch (error) {
    next(error);
  }
};

const putUser = async (req = request, res = response, next) => {
  const { id } = req.params;
  const { name, password, role, state } = req.body;

  // explicit whitelist: anything else in the body (email, google, image, _id...) is dropped
  const data = {};
  if (name !== undefined) data.name = name;
  if (req.user.role === "ADMIN_ROLE") {
    if (role !== undefined) data.role = role;
    if (state !== undefined) data.state = state;
  }

  //TODO validar contra base de datos
  try {
    if (password) {
      //Encript password
      data.password = await bcrypt.hash(password, 10);
    }
  
    const user = await User.findByIdAndUpdate(id, data, {new: true});

    res.json(user);

  } catch (error) {
    next(error);
  }
};

const usuariosPatch = (req = request, res = response) => {
  res.json({
    msg: "patch API - usuariosPatch",
  });
};

const deleteUser = async (req = request, res = response, next) => {

  const { id } = req.params;
  //physically eliminated
  try {

    const userDelete = await User.findByIdAndUpdate(id, {state: false});
    const userAuthenticated = req.user
    res.status(201).json({userDelete, userAuthenticated});

  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUsers,
  postUser,
  putUser,
  usuariosPatch,
  deleteUser,
};
