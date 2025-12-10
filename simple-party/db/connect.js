import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: { rejectUnauthorized: false },
});

export async function connect() {
    const result = await pool.query('SELECT NOW()');
    console.log('Database connected:', result.rows[0].now);
    return pool;
}

export default pool;
