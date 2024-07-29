require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT,
});

pool.query('SELECT * FROM public.usuarios;', (error, results) => {
  if (error) {
    throw error;
  }
  console.log(results.rows);
  pool.end();
});
