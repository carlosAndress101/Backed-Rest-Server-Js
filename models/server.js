const cors = require('cors');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const userRouter  = require('../routes/usuarios');
const authRouter  = require('../routes/auth');
const categoryRouter  = require('../routes/category');
const productRouter  = require('../routes/products');
const searchRouter  = require('../routes/search');
const uploadRouter  = require('../routes/uploads');

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

        // Middlewares
        this.middlewares();

        // router of the app
        this.routes();
    }

    middlewares() {

        this.app.disable('x-powered-by');

        // TRUST_PROXY: how many reverse proxies sit in front of the app, so req.ip (and the
        // auth rate limiter) sees the client's address; unset keeps the socket address
        const { TRUST_PROXY = '' } = process.env;
        if( TRUST_PROXY !== '' ){
            if( !/^\d+$/.test(TRUST_PROXY) ){
                throw new Error(`TRUST_PROXY must be a non-negative integer hop count, got "${ TRUST_PROXY }"`);
            }
            this.app.set('trust proxy', Number(TRUST_PROXY));
        }

        // security headers; the CSP and COOP keep the demo page's Google
        // sign-in and fonts working, CORP lets other origins embed images
        this.app.use( helmet({
            contentSecurityPolicy: {
                directives: {
                    scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
                    styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style', 'https://fonts.googleapis.com'],
                    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
                    frameSrc: ['https://accounts.google.com/gsi/'],
                    connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
                }
            },
            crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
            crossOriginResourcePolicy: { policy: 'cross-origin' },
            referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        }) );

        // CORS
        this.app.use( cors() );

        // Lectura y parseo del body
        // read and parse from body
        this.app.use( express.json() );

        //public path
        this.app.use(express.static(path.join(__dirname, '../public')))

        // multipart bodies are parsed only by the upload routes (fileParser)
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

        // unknown routes
        this.app.use((req, res) => {
            res.status(404).json({
                msg: 'Route not found'
            })
        })

        // error handler, must stay the last middleware
        this.app.use((err, req, res, next) => {
            // client errors from the HTTP layer (malformed JSON, bad URL escapes):
            // http-errors flags them with expose, Express's URL decoding only sets status
            const isClientError = err.status >= 400 && err.status < 500
                && ( err.expose === true || err instanceof URIError );

            if( isClientError && !res.headersSent ){
                console.warn(`${ err.status } ${ req.method } ${ req.originalUrl }: ${ err.message }`);
                return res.status(err.status).json({
                    msg: 'Invalid request data'
                })
            }

            console.error(err);

            if( res.headersSent ){
                return next(err);
            }

            if( err.code === 11000 ){
                return res.status(409).json({
                    msg: 'Resource already exists'
                })
            }

            if( err.name === 'ValidationError' || err.name === 'CastError' ){
                return res.status(400).json({
                    msg: 'Invalid request data'
                })
            }

            res.status(500).json({
                msg: 'Internal server error'
            })
        })
    }

    listen(){
        return this.app.listen(this.port, ()=>{
            console.log(`Server listening on :${ this.port }`);
        })
    }
}




module.exports = Server;
