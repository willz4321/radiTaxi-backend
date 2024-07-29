const pool = require('../../config/dbConfig');

exports.getAllUsers = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM usuarios;');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener usuarios:', err);
    res.status(500).send('Error al obtener los usuarios');
  }
};
