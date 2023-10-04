const { v4: uuidv4 } = require('uuid');
const path = require("path");

const uploadFile = ( files, ValidExtensions = ["png", "jpg", "jpeg", "gif"], folder = '') => {
  return new Promise((resolve, reject) => {

    const { file } = files;

    const nameCuted = file.name.split(".");
    const extension = nameCuted[nameCuted.length - 1];

    //validate the extension
    if (!ValidExtensions.includes(extension)) {
        return reject(`extension ${extension} is not allowed - ${ValidExtensions}`)
    }

    //rename file
    const tempNameFile = `${uuidv4()}.${extension}`;

    //path file
    const uploadPath = path.join(__dirname, "../uploads/", folder, tempNameFile);

    //move file
    file.mv(uploadPath, err => {
      if (err) {
        return reject(err);
      }

      resolve(tempNameFile);
    });

  });
};

module.exports = {
  uploadFile
};
