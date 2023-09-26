const mongoose = require('mongoose');

const connection = async () => {
    mongoose.set("strictQuery", false);
    await mongoose.connect(process.env.MONGO_CLOUD);
}

module.exports = connection;