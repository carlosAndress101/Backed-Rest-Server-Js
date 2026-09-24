const fs = require("fs");
const os = require("os");
const { response } = require("express");
const expressFileUpload = require("express-fileupload");


// Upload files: one file, max 5 MB (larger requests are aborted with 413)
const parseFiles = expressFileUpload({
    useTempFiles : true,
    tempFileDir : os.tmpdir(),
    createParentPath : true,
    limits : { fileSize: 5 * 1024 * 1024, files: 1 },
    abortOnLimit : true,
});

// express-fileupload never removes its temp files; a moved file is already gone
const removeTempFiles = (files) => {
    Object.values(files || {}).flat().forEach(({ tempFilePath }) => {
        if (tempFilePath) {
            fs.rm(tempFilePath, { force: true }, err => err && console.error(err));
        }
    });
};

/**
 * Parses the multipart body of the upload routes. Mount it after authentication,
 * authorization and param validation so a rejected request never writes a temp file.
 * Whatever the request wrote is removed once the response is over, on every exit path.
 */
const fileParser = (req, res = response, next) => {
    res.on('close', () => removeTempFiles(req.files));
    parseFiles(req, res, next);
}

const fileValid = (req, res = response, next) => {
    if (!req.files || Object.keys(req.files).length === 0 || !req.files.file) {
        return res.status(400).json({ msg: "No files were uploaded - fileValid middleware" });
    }
    next();
}


module.exports = {
    fileParser,
    fileValid
}