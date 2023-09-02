const mongoose = require('mongoose');

const connection = async () => {
    try {
        mongoose.set("strictQuery", false);
        const connect = await mongoose.connect(process.env.MONGO_CLOUD);
        console.log(`-> Database up`)
    } catch (error) {
        console.error(error);
        throw new Error("unable to connect to the database"),
        process.exit(1)
    }
}

module.exports = connection;