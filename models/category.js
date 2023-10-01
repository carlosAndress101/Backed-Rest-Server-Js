const { model, Schema} = require('mongoose');
const mongoose = require('mongoose');

const CategorySchema = Schema({
    name:{
        type:String,
        unique: true,
        required: [true, 'The name is required']
    },
    state:{
        type:Boolean,
        default: true,
        required: true
    },
    user:{
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
},{
    versionKey: false
});


module.exports = model('Category', CategorySchema);
