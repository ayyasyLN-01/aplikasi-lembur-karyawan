const { Pool } = require('pg');

// Mesin akan mencari tautan DATABASE_URL dari server awan (Render).
// Jika tidak ada (saat kita coba di laptop), ia akan menggunakan tautan Neon Anda.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_hBVJnqao13dx@ep-purple-queen-aoygcqcn.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    ssl: {
        rejectUnauthorized: false // Wajib ditambahkan agar koneksi internet disetujui
    }
});

module.exports = pool;