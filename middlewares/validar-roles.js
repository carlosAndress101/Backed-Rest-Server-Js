const { request, response } = require("express");


const esAdminRole = (req = request, res = response, next) => {
    if( !req.user ){
        return res.status(500).json({
            msg:'you want to verify the role without validating the token first'
        });
    }

    const { role, name } = req.user;


    if(role !== "ADMIN_ROLE"){
        return res.status(400).json({
            msg:`${ name } is not an administrator - You cannot do this`
        })
    }

    next();
}

const hasRole = ( ...roles ) => {
    return (req = request, res = response, next) => {

        if( !req.user ){
            return res.status(500).json({
                msg:'you want to verify the role without validating the token first'
            });
        }

        if( !roles.includes( req.user.role)){
            return res.status(401).json({
                msg:`The service required one of these roles ${ roles }`
            })
        }
        
        next();
    }
}

module.exports = {
    esAdminRole,
    hasRole
}