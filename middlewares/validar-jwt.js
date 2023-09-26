const { response, request } = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/user');


const validarJWT = async (req = request, res = response, next) => {

    const token = req.header('x-token')

    if( !token ){
        return res.status(401).json({
            msg: ' No hay token en la petición'
        })
    }
    
    try {

        const { uid } = jwt.verify(token, process.env.SECRET_KEY);
       
        //read user corresponding to uid
        const user = await User.findById( uid );

        //validate exist user
        if( !user ){
            return res.status(401).json({
                msg: 'Token not valid - user removed from DB'
            })
        }

        //verify state of user
        if(!user.state){
            return res.status(401).json({
                msg: 'Token not valid - user with state: false'
            })
        }

        req.user = user;
        next();

    } catch (error) {
        console.log(error);
        res.status(401).json({
            msg:'Token no válido'
        })
    }
}


module.exports = {
    validarJWT
}