const cors = require('cors');
const path = require('path');
const express = require('express');
const userRouter  = require('../routes/usuarios');
const authRouter  = require('../routes/auth');

const connection = require('../database/config');

class Server {

    constructor() {
        this.app = express();
        this.port = process.env.PORT || 1500;
        this.userPath = '/api/user';
        this.authPath = '/api/auth';
        this.origin = 'http://localhost:';

        // Conectar a base de datos
        this.conectarDB();

        // Middlewares
        this.middlewares();

        // Rutas de mi aplicación
        this.routes();
    }

    async conectarDB() {
        await connection();
    }


    middlewares() {

        // CORS
        this.app.use( cors() );

        // Lectura y parseo del body
        this.app.use( express.json() );

        //directorio publico
        this.app.use(express.static(path.join(__dirname, '../public')))

    }

    //routes
    routes(){
        this.app.get('/hello', (req, res) => {
            res.status(200).json({
                name: 'caan'
            })
        })
        this.app.use(this.userPath, userRouter)
        this.app.use(this.authPath, authRouter)
    }

    listen(){
        return this.app.listen(this.port, ()=>{
        })
    }

}




module.exports = Server;
