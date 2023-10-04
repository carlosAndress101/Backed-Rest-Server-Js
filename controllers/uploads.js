const fs = require("fs");
const path = require('path');
const cloudinary = require('cloudinary').v2;
cloudinary.config(process.env.CLOUDINARY_URL);

const { response } = require("express");
const { uploadFile } = require("../helpers");

const {User, Product} = require('../models');


const fileUpload = async (req, res = response) => {
  
  try {
    //req - extension - folder
    // example - const fullName = await uploadFile(req.files, ['txt', 'md'], 'textos');
    const fullName = await uploadFile(req.files, undefined, 'imgs');
    res.json({ fullName });

  } catch (msg) {
    res.status(400).json({ msg });
  }
};


/**
 * http://localhost:4321/api/uploads/collection/id
 */
const updateImage = async (req, res = response) => {

    const {collection, id} = req.params;

    let model ;

    switch (collection) {
        case 'user':
            model = await User.findById(id);
            if ( !model ) {
                return res.status(400).json({ msg:`The user does not exist with id ${id}`})
            }
            break;
    
        case 'product':
            model = await Product.findById(id);
            if ( !model ) {
                return res.status(400).json({ msg:`The product does not exist with id ${id}`})
            }
            break;
    
        default:
            return res.status(400).json({ msg:'I forgot to do this'})
    }

    //clean preview images
    if( model.image){
        //the image must be deleted from the server
        const pathImage = path.join(__dirname, "../uploads", collection, model.image);
        if(fs.existsSync(pathImage)){
            fs.unlinkSync(pathImage);
        }
    }
    

    const fullName = await uploadFile(req.files, undefined, collection);
    model.image = fullName;
    await model.save();

    res.json( model )
}


const showImage = async (req, res = response) => {

    const { id, collection } = req.params;

    let model ;

    switch (collection) {
        case 'user':
            model = await User.findById(id);
            if ( !model ) {
                return res.status(400).json({ msg:`The user does not exist with id ${id}`})
            }
            break;
    
        case 'product':
            model = await Product.findById(id);
            if ( !model ) {
                return res.status(400).json({ msg:`The product does not exist with id ${id}`})
            }
            break;
    
        default:
            return res.status(400).json({ msg:'I forgot to do this'})
    }

    //clean preview images
    if( model.image){
        //the image must be find in the server
        const pathImage = path.join(__dirname, "../uploads", collection, model.image);
        if(fs.existsSync(pathImage)){
            return res.sendFile(pathImage);
        }
    }

    const pathImageNotFound = path.join(__dirname, "../assets/notFound.jpg");
    res.sendFile(pathImageNotFound);
}

const updateImageCloudinary = async (req, res = response) => {

    const {collection, id} = req.params;

    let model ;

    switch (collection) {
        case 'user':
            model = await User.findById(id);
            if ( !model ) {
                return res.status(400).json({ msg:`The user does not exist with id ${id}`})
            }
            break;
    
        case 'product':
            model = await Product.findById(id);
            if ( !model ) {
                return res.status(400).json({ msg:`The product does not exist with id ${id}`})
            }
            break;
    
        default:
            return res.status(400).json({ msg:'I forgot to do this'})
    }

    //clean preview images
    if( model.image){
        const nameArr = model.image.split("/");
        const name    = nameArr[nameArr.length- 1];
        const [ public_id ]      = name.split(".");
        cloudinary.uploader.destroy( public_id );
    }

    console.log(req.files);
    const { tempFilePath } = req.files.file
    const { secure_url } = await cloudinary.uploader.upload( tempFilePath )
    
    model.image = secure_url;
    await model.save();

    res.json( model )
}


module.exports = {
  fileUpload,
  updateImage,
  showImage,
  updateImageCloudinary
};
