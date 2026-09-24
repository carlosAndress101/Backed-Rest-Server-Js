const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { response } = require("express");
const expressFileUpload = require("express-fileupload");


// Upload files: one file, max 5 MB (larger requests are aborted with 413)
const uploadOptions = {
    useTempFiles : true,
    createParentPath : true,
    limits : { fileSize: 5 * 1024 * 1024, files: 1 },
    abortOnLimit : true,
};

/**
 * Parses the multipart body of the upload routes. Mount it after authentication,
 * authorization and param validation so a rejected request never writes a temp file.
 *
 * The request's temp files go into their own folder under os.tmpdir() (created with
 * the first file), removed as a whole once the response is over, whatever the exit
 * path. A folder also catches the file express-fileupload fails to delete itself
 * when an upload breaks off mid-file, which never reaches req.files.
 */
const fileParser = (req, res = response, next) => {
    const tempFileDir = path.join(os.tmpdir(), `upload-${ process.pid }-${ randomUUID() }`);

    res.on('close', () => {
        fs.rm(tempFileDir, { recursive: true, force: true, maxRetries: 3 }, err => err && req.log.warn({ err, tempFileDir }, 'upload temp folder not removed'));
    });

    expressFileUpload({ ...uploadOptions, tempFileDir })(req, res, next);
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