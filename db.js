const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '3306', 10),
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'wpjava',
      waitForConnections: true,
      connectionLimit: 10,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return pool;
}

async function query(sql, params) {
  let retries = 3;
  while (retries > 0) {
    try {
      const [rows] = await getPool().execute(sql, params);
      return rows;
    } catch (err) {
      retries--;
      // Si el pool está roto, destruirlo para que se recree en el siguiente intento
      if (pool) { try { await pool.end(); } catch (_) {} pool = null; }
      if (retries === 0) throw err;
      console.log(`[db] Error, reintentando (${retries} intentos)...`, err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

module.exports = { query };
