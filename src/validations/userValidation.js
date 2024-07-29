const Joi = require('joi');

const registerValidation = (data) => {
  const schema = Joi.object({
    id_usuario: Joi.string().required(),
    nombre: Joi.string().min(3).required(),
    password: Joi.string().min(6).required(),
    foto: Joi.string().optional(),
    tipo: Joi.string().valid('tipo1', 'tipo2', 'tipo3').required()  // Añadiendo campo 'tipo'
  });
  return schema.validate(data, { allowUnknown: true });
};

const loginValidation = (data) => {
  const schema = Joi.object({
    id_usuario: Joi.string().required(),
    password: Joi.string().required()
  });
  return schema.validate(data);
};

module.exports = {
  registerValidation,
  loginValidation
};
