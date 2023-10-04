const cors = require('cors');
const path = require('path');
const express = require('express');
const fileUpload = require('express-fileupload');
const userRouter  = require('../routes/usuarios');
const authRouter  = require('../routes/auth');
const categoryRouter  = require('../routes/category');
const productRouter  = require('../routes/products');
const searchRouter  = require('../routes/search');
const uploadRouter  = require('../routes/uploads');

const connection = require('../database/config');

class Server {

    constructor() {
        this.app = express();
        this.port = process.env.PORT || 1500;

        this.paths = {
            auth: '/api/auth',
            search: '/api/search',
            user: '/api/user',
            categoty: '/api/category',
            product: '/api/product',
            uploads: '/api/uploads'
        }

        // connect to the DB
        this.conectarDB();

        // Middlewares
        this.middlewares();

        // router of the app
        this.routes();
    }

    async conectarDB() {
        await connection();
    }


    middlewares() {

        // CORS
        this.app.use( cors() );

        // Lectura y parseo del body
        // read and parse from body
        this.app.use( express.json() );

        //public path
        this.app.use(express.static(path.join(__dirname, '../public')))

        //Upload files
        this.app.use(fileUpload({
            useTempFiles : true,
            tempFileDir : '/tmp/',
            createParentPath : true,
        }));
    }

    //routes
    routes(){
        this.app.get('/hello', (req, res) => {
            res.status(200).json({
                name: 'caan'
            })
        })
        this.app.use(this.paths.user, userRouter)
        this.app.use(this.paths.auth, authRouter)
        this.app.use(this.paths.categoty, categoryRouter)
        this.app.use(this.paths.product, productRouter)
        this.app.use(this.paths.search, searchRouter)
        this.app.use(this.paths.uploads, uploadRouter)
    }

    listen(){
        return this.app.listen(this.port, ()=>{
        })
    }
}




module.exports = Server;
