const { request, response } = require("express");


const esAdminRole = (req = request, res = response, next) => {
    if( !req.user ){
        return res.status(500).json({
            msg:'you want to verify the role without validating the token first'
        });
    }

    const { role, name } = req.user;


    if(role !== "ADMIN_ROLE"){
        return res.status(403).json({
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
            return res.status(403).json({
                msg:`The service required one of these roles ${ roles }`
            })
        }
        
        next();
    }
}

/**
 * Lets an administrator through, or a user acting on their own user record
 * (`/:id` or `/user/:id`). Any other `:collection` is admin-only.
 */
const esAdminOrOwner = (req = request, res = response, next) => {
    if( !req.user ){
        return res.status(500).json({
            msg:'you want to verify the role without validating the token first'
        });
    }

    const { role, id, name } = req.user;
    const { collection = 'user' } = req.params;
    const isOwner = collection === 'user' && id === req.params.id;

    if( role !== "ADMIN_ROLE" && !isOwner ){
        return res.status(403).json({
            msg:`${ name } is not the owner or an administrator - You cannot do this`
        })
    }

    next();
}

module.exports = {
    esAdminRole,
    esAdminOrOwner,
    hasRole
}