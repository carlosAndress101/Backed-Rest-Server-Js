require('dotenv').config();
const Server = require('./models/server');
const connection = require('./database/config');


const main = async () => {
    await connection();

    const server = new Server();
    server.listen();
}

main().catch( error => {
    console.error(error);
    process.exit(1);
});
