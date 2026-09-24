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
            // name + root: Express 5 refuses an absolute path that has a dot-directory in it
            return res.sendFile(model.image, { root: folder });
        }
    }

    const pathImageNotFound = path.join(__dirname, "../assets/notFound.jpg");
    res.sendFile(path.basename(pathImageNotFound), { root: path.dirname(pathImageNotFound) });
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

        const previousImage = model.image;

        const { tempFilePath } = req.files.file
        const { secure_url } = await cloudinary.uploader.upload( tempFilePath )
        
        model.image = secure_url;
        try {
            await model.save();
        } catch (error) {
            // the record keeps its previous image, so the one just uploaded is orphaned
            console.error(`Orphaned Cloudinary asset ${ secure_url }: the ${ collection } ${ id } was not saved`);
            throw error;
        }

        //clean preview images, only once the record points at the new one
        if( previousImage ){
            const nameArr = previousImage.split("/");
            const name    = nameArr[nameArr.length- 1];
            const [ public_id ]      = name.split(".");
            try {
                await cloudinary.uploader.destroy( public_id );
            } catch (error) {
                // a stale previous image must not fail an update that already succeeded
                console.error(error);
            }
        }

        res.json( model )
    } catch (error) {
        next(error);
    }
}


module.exports = {
  fileUpload,
  showImage,
  updateImageCloudinary
};
