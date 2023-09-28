const cors = require('cors');
const path = require('path');
const express = require('express');
const userRouter  = require('../routes/usuarios');
const authRouter  = require('../routes/auth');
const categoryRouter  = require('../routes/category');

const connection = require('../database/config');

class Server {

    constructor() {
        this.app = express();
        this.port = process.env.PORT || 1500;

        this.paths = {
            auth: '/api/auth',
            user: '/api/user',
            categoty: '/api/category'
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
    }

    listen(){
        return this.app.listen(this.port, ()=>{
        })
    }
}




module.exports = Server;
