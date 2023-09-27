const bcrypt = require('bcrypt');
const User = require("../models/user.js");
const { request, response } = require("express");
const {generarJWT} = require('../helpers/generar-jwt.js');
const { googleVerify } = require("../helpers/google-verify.js");

const login = async (req = request, res = response) => {
    const {email, password} = req.body;

    try {
        //verify if the email exist
        const user = await User.findOne({ email });
        if(!user){
            return res.status(400).json({
                msg: 'user / email not valid - email'
            });
        }

        //verify if the user active
        if(!user.state){
            return res.status(400).json({
                msg: 'user / state not valid - state:false'
            })
        }

        //verify the password
        const validPassword = bcrypt.compareSync(password, user.password);
        if(!validPassword){
            return res.status(400).json({
                msg: 'user / Password not valid - password'
            })
        }
        
        //Generate the JWT
        const token = await generarJWT( user.id );

        res.json({
            user,
            token
        })

    } catch (error) {
        console.log(error)
        res.status(500).json({
            msg:'Talk to the administrator'
        })
    }
}

const googleSignin = async(req = request, res = response) => {

    const { id_token } = req.body;
    
    try {
        const { name, picture, email} = await googleVerify( id_token );
        let user = await User.findOne({ email });

        if ( !user ) {
            // create user
            const data = { name, email, password:':D', image:picture, google:true };
            user = new User( data );
            await user.save();
        }

        // if the user in DB
        if ( !user.state ) {
            return res.status(401).json({
                msg: 'Takl to the administrator - blocked user'
            });
        }

        // Generate the JWT
        const token = await generarJWT( user.id );
        
        res.json({
            user,
            token
        });
        
    } catch (error) {
        res.status(400).json({
            msg: 'Token of Google not valied'
        })

    }
}
    

module.exports = {
    login,
    googleSignin
}