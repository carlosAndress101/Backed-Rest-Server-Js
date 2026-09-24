const bcrypt = require('bcrypt');
const User = require("../models/user.js");
const { request, response } = require("express");
const {generarJWT} = require('../helpers/generar-jwt.js');
const { googleVerify } = require("../helpers/google-verify.js");

// Compared against when the email is unknown, so every credential failure costs one bcrypt check
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

// A hash bcrypt really does work on ($2a$/$2b$, cost 04-31). Anything else, like the
// ':D' placeholder of Google-created accounts, would fail instantly and reveal the account.
const BCRYPT_HASH = /^\$2[ab]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

const invalidCredentials = (res = response) => res.status(401).json({
    msg: 'Invalid credentials'
});

const login = async (req = request, res = response, next) => {
    const {email, password} = req.body;

    try {
        //verify if the email exist
        const user = await User.findOne({ email });

        //verify the password, the user and its state with the same response for each failure;
        //an account without a password hash is compared against the dummy one and never matches
        const hasPasswordHash = Boolean(user) && BCRYPT_HASH.test(user.password);
        const validPassword = bcrypt.compareSync(password, hasPasswordHash ? user.password : DUMMY_HASH);
        if(!hasPasswordHash || !user.state || !validPassword){
            return invalidCredentials(res);
        }
        
        //Generate the JWT
        const token = await generarJWT( user.id );

        res.json({
            user,
            token
        })

    } catch (error) {
        next(error);
    }
}

const googleSignin = async(req = request, res = response, next) => {

    const { id_token } = req.body;
    
    let payload;
    try {
        payload = await googleVerify( id_token );
    } catch (error) {
        return invalidCredentials(res);
    }

    try {
        const { name, picture, email} = payload;
        let user = await User.findOne({ email });

        if ( !user ) {
            // create user
            const data = { name, email, password:':D', image:picture, google:true };
            user = new User( data );
            await user.save();
        }

        // if the user in DB
        if ( !user.state ) {
            return invalidCredentials(res);
        }

        // Generate the JWT
        const token = await generarJWT( user.id );
        
        res.json({
            user,
            token
        });
        
    } catch (error) {
        next(error);
    }
}
    

module.exports = {
    login,
    googleSignin
}