const bcrypt = require('bcrypt');
const User = require("../models/user.js");
const { request, response } = require("express");
const {generarJWT} = require('../helpers/generar-jwt.js');
const { googleVerify } = require("../helpers/google-verify.js");

// Compared against when the email is unknown, so every credential failure costs one bcrypt check
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

const invalidCredentials = (res = response) => res.status(401).json({
    msg: 'Invalid credentials'
});

const login = async (req = request, res = response, next) => {
    const {email, password} = req.body;

    try {
        //verify if the email exist
        const user = await User.findOne({ email });

        //verify the password, the user and its state with the same response for each failure
        const validPassword = bcrypt.compareSync(password, user ? user.password : DUMMY_HASH);
        if(!user || !user.state || !validPassword){
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