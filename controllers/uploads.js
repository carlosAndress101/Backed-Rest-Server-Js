const fs = require("fs");
const path = require('path');
const cloudinary = require('cloudinary').v2;
// credentials come from the CLOUDINARY_URL env var, which the SDK reads itself
cloudinary.config({ secure: true });

const { response } = require("express");
const { uploadFile } = require("../helpers");

const {User, Product} = require('../models');


const fileUpload = async (req, res = response, next) => {
  
  try {
    //req - extension - folder
    // example - const fullName = await uploadFile(req.files, ['txt', 'md'], 'textos');
    const fullName = await uploadFile(req.files, undefined, 'imgs');
    res.json({ fullName });

  } catch (error) {
    // uploadFile rejects with a message string when the extension is not allowed
    if (typeof error === 'string') {
      return res.status(400).json({ msg: error });
    }
    next(error);
  }
};


/**
 * http://localhost:4321/api/uploads/collection/id
 */
const updateImage = async (req, res = response, next) => {

    const {collection, id} = req.params;

    let model ;

    try {
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
    } catch (error) {
        next(error);
    }
}


const showImage = async (req, res = response, next) => {

    const { id, collection } = req.params;

    let model ;

    try {
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
    } catch (error) {
        return next(error);
    }

    //clean preview images
    if( model.image){
        //the image must be find in the server, as a bare filename inside uploads/<collection>
        const folder = path.join(__dirname, "../uploads", collection);
        const pathImage = path.resolve(folder, model.image);
        const isBareFileName = path.basename(model.image) === model.image;
        const isInsideFolder = pathImage.startsWith(folder + path.sep);

        if(isBareFileName && isInsideFolder && fs.existsSync(pathImage)){
            return res.sendFile(pathImage);
        }
    }

    const pathImageNotFound = path.join(__dirname, "../assets/notFound.jpg");
    res.sendFile(pathImageNotFound);
}

const updateImageCloudinary = async (req, res = response, next) => {

    const {collection, id} = req.params;

    let model ;

    try {
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
            try {
                await cloudinary.uploader.destroy( public_id );
            } catch (error) {
                // a stale previous image must not block the new upload
                console.error(error);
            }
        }

        const { tempFilePath } = req.files.file
        const { secure_url } = await cloudinary.uploader.upload( tempFilePath )
        
        model.image = secure_url;
        await model.save();

        res.json( model )
    } catch (error) {
        next(error);
    }
}


module.exports = {
  fileUpload,
  updateImage,
  showImage,
  updateImageCloudinary
};
