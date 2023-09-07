const { request, response } = require("express");
const User = require("../models/user.js");
const bcrypt = require('bcrypt');

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
        res.json({
            msg:'Login ok',
            email, password
        })
    } catch (error) {
        console.log(error)
        res.status(500).json({
            msg:'talk to the administrator'
        })
    }
    
}

module.exports = {
    login
}