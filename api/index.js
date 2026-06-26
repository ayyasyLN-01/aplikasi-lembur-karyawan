const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();
// const port = 3000;
// Render akan secara otomatis memberikan "Port" rahasia untuk aplikasi Anda.
const port = process.env.PORT || 3000;
const db = require('./db');

const KUNCI_RAHASIA = 'kunci_rahasia_super_aman_123';

app.use(express.json());
app.use(express.static('public'));

// =======================================================
// JALUR REGISTRASI KARYAWAN BARU
// =======================================================
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, namaLengkap, gajiPokok } = req.body;
        if (!username || !password || !namaLengkap || !gajiPokok) return res.status(400).json({ pesan: "Data tidak lengkap!" });

        // Cek apakah username sudah dipakai
        const cekUser = await db.query('SELECT * FROM profil_karyawan WHERE username = $1', [username]);
        if (cekUser.rows.length > 0) return res.status(400).json({ pesan: "Username sudah terdaftar!" });

        const salt = await bcrypt.genSalt(10);
        const hashed = await bcrypt.hash(password, salt);

        await db.query(
            'INSERT INTO profil_karyawan (username, password_hash, nama_lengkap, gaji_pokok, status_akun) VALUES ($1, $2, $3, $4, $5)',
            [username, hashed, namaLengkap, gajiPokok, 'pending']
        );
        res.json({ pesan: "Registrasi berhasil! Silakan hubungi Administrator untuk persetujuan." });
    } catch (error) {
        res.status(500).json({ pesan: "Gagal melakukan registrasi." });
    }
});

// =======================================================
// JALUR LOGIN (Dengan Filter Status Akun)
// =======================================================
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Cek Karyawan
        let hasilDb = await db.query('SELECT * FROM profil_karyawan WHERE username = $1', [username]);
        if (hasilDb.rows.length > 0) {
            const user = hasilDb.rows[0];
            const valid = await bcrypt.compare(password, user.password_hash);
            if (!valid) return res.status(401).json({ pesan: "Password salah!" });

            // BLOKIR JIKA STATUS MASIH PENDING
            if (user.status_akun === 'pending') return res.status(403).json({ pesan: "Akun Anda sedang menunggu persetujuan Administrator." });

            const token = jwt.sign({ id: user.id, nama: user.nama_lengkap, role: 'karyawan' }, KUNCI_RAHASIA, { expiresIn: '8h' });
            return res.json({ pesan: "Login Karyawan berhasil!", token, role: 'karyawan' });
        }

        // Cek Admin
        hasilDb = await db.query('SELECT * FROM admin_users WHERE username = $1', [username]);
        if (hasilDb.rows.length > 0) {
            const admin = hasilDb.rows[0];
            const valid = await bcrypt.compare(password, admin.password_hash);
            if (!valid) return res.status(401).json({ pesan: "Password salah!" });

            const token = jwt.sign({ id: admin.id, nama: 'Administrator', role: 'admin' }, KUNCI_RAHASIA, { expiresIn: '8h' });
            return res.json({ pesan: "Login Admin berhasil!", token, role: 'admin' });
        }
        res.status(401).json({ pesan: "Username tidak ditemukan!" });
    } catch (error) { res.status(500).json({ pesan: "Error sistem." }); }
});

// Middleware Sensor Keamanan
const verifikasiToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(403).json({ pesan: "Akses Ditolak!" });

    jwt.verify(token, KUNCI_RAHASIA, (err, user) => {
        if (err) return res.status(403).json({ pesan: "Sesi login berakhir!" });
        req.user = user;
        next();
    });
};

// =======================================================
// JALUR KARYAWAN: INPUT, RIWAYAT, EDIT, HAPUS LEMBUR
// =======================================================

// 1. Input Lembur Baru
app.post('/api/hitung-lembur', verifikasiToken, async (req, res) => {
    try {
        const { tanggalLembur, jenisHari, jamLembur } = req.body;

        if (!tanggalLembur || !jenisHari || !jamLembur || jamLembur <= 0) {
            return res.status(400).json({ pesan: "Data tidak valid!" });
        }

        // Ambil gaji pokok dari database profil
        const userQuery = await db.query('SELECT gaji_pokok FROM profil_karyawan WHERE id = $1', [req.user.id]);
        if (userQuery.rows.length === 0) return res.status(404).json({ pesan: "Karyawan tidak ditemukan." });

        const gajiPokok = userQuery.rows[0].gaji_pokok;
        const upahSejam = gajiPokok / 173;
        let totalUangLembur = 0;

        if (jenisHari === 'Weekday') {
            if (jamLembur <= 1) totalUangLembur = jamLembur * 1.5 * upahSejam;
            else totalUangLembur = (1.5 * upahSejam) + ((jamLembur - 1) * 2 * upahSejam);
        } else if (jenisHari === 'Offday') {
            if (jamLembur <= 8) totalUangLembur = jamLembur * 2 * upahSejam;
            else if (jamLembur === 9) totalUangLembur = (8 * 2 * upahSejam) + (1 * 3 * upahSejam);
            else totalUangLembur = (8 * 2 * upahSejam) + (1 * 3 * upahSejam) + ((jamLembur - 9) * 4 * upahSejam);
        }

        const totalDibulatkan = Math.round(totalUangLembur);

        const queryTeks = `INSERT INTO lembur_karyawan (user_id, tanggal_lembur, jenis_hari, jam_lembur, total_uang_lembur) VALUES ($1, $2, $3, $4, $5) RETURNING *`;
        const hasil = await db.query(queryTeks, [req.user.id, tanggalLembur, jenisHari, jamLembur, totalDibulatkan]);

        res.json({ pesan: "Berhasil!", dataTersimpan: hasil.rows[0] });
    } catch (error) { res.status(500).json({ pesan: "Error server." }); }
});

// 2. Tarik Riwayat Lembur Sendiri
app.get('/api/riwayat-lembur', verifikasiToken, async (req, res) => {
    try {
        const queryTeks = `SELECT * FROM lembur_karyawan WHERE user_id = $1 ORDER BY tanggal_lembur DESC`;
        const hasil = await db.query(queryTeks, [req.user.id]);
        res.json(hasil.rows);
    } catch (error) { res.status(500).json({ pesan: "Gagal mengambil data." }); }
});

// 3. Edit Catatan Lembur
app.put('/api/lembur/:id', verifikasiToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { tanggalLembur, jenisHari, jamLembur } = req.body;

        const userQuery = await db.query('SELECT gaji_pokok FROM profil_karyawan WHERE id = $1', [req.user.id]);
        const gajiPokok = userQuery.rows[0].gaji_pokok;
        const upahSejam = gajiPokok / 173;
        let totalUangLembur = 0;

        if (jenisHari === 'Weekday') {
            if (jamLembur <= 1) totalUangLembur = jamLembur * 1.5 * upahSejam;
            else totalUangLembur = (1.5 * upahSejam) + ((jamLembur - 1) * 2 * upahSejam);
        } else if (jenisHari === 'Offday') {
            if (jamLembur <= 8) totalUangLembur = jamLembur * 2 * upahSejam;
            else if (jamLembur === 9) totalUangLembur = (8 * 2 * upahSejam) + (1 * 3 * upahSejam);
            else totalUangLembur = (8 * 2 * upahSejam) + (1 * 3 * upahSejam) + ((jamLembur - 9) * 4 * upahSejam);
        }

        const queryTeks = `UPDATE lembur_karyawan SET tanggal_lembur = $1, jenis_hari = $2, jam_lembur = $3, total_uang_lembur = $4 WHERE id = $5 AND user_id = $6`;
        await db.query(queryTeks, [tanggalLembur, jenisHari, jamLembur, Math.round(totalUangLembur), id, req.user.id]);
        res.json({ pesan: "Teredit" });
    } catch (error) { res.status(500).json({ pesan: "Gagal edit." }); }
});

// 4. Hapus Catatan Lembur
app.delete('/api/lembur/:id', verifikasiToken, async (req, res) => {
    try {
        await db.query(`DELETE FROM lembur_karyawan WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
        res.json({ pesan: "Terhapus" });
    } catch (error) { res.status(500).json({ pesan: "Gagal hapus." }); }
});

// =======================================================
// JALUR KHUSUS ADMIN: MENYETUJUI / MENOLAK KARYAWAN
// =======================================================
app.get('/api/admin/pending-users', verifikasiToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ pesan: "Akses Ditolak!" });
        const hasil = await db.query('SELECT id, username, nama_lengkap, gaji_pokok FROM profil_karyawan WHERE status_akun = $1', ['pending']);
        res.json(hasil.rows);
    } catch (error) { res.status(500).json({ pesan: "Gagal mengambil daftar karyawan." }); }
});

app.put('/api/admin/approve-user/:id', verifikasiToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ pesan: "Akses Ditolak!" });
        const { gajiPokok } = req.body;
        await db.query('UPDATE profil_karyawan SET status_akun = $1, gaji_pokok = $2 WHERE id = $3', ['approved', gajiPokok, req.params.id]);
        res.json({ pesan: "Disetujui" });
    } catch (error) { res.status(500).json({ pesan: "Gagal menyetujui." }); }
});

app.delete('/api/admin/reject-user/:id', verifikasiToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ pesan: "Akses Ditolak!" });
        await db.query('DELETE FROM profil_karyawan WHERE id = $1 AND status_akun = $2', [req.params.id, 'pending']);
        res.json({ pesan: "Ditolak" });
    } catch (error) { res.status(500).json({ pesan: "Gagal menolak." }); }
});

// =======================================================
// JALUR ADMIN: REKAPITULASI SEMUA LEMBUR
// =======================================================
app.get('/api/admin/semua-lembur', verifikasiToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ pesan: "Akses Ditolak!" });
        const { tahun, bulan } = req.query;
        let queryTeks = `
            SELECT l.*, p.nama_lengkap 
            FROM lembur_karyawan l
            JOIN profil_karyawan p ON l.user_id = p.id
            WHERE EXTRACT(YEAR FROM l.tanggal_lembur) = $1
        `;
        let params = [tahun || new Date().getFullYear()];

        if (bulan && bulan !== '0') {
            queryTeks += ` AND EXTRACT(MONTH FROM l.tanggal_lembur) = $2`;
            params.push(bulan);
        }
        queryTeks += ` ORDER BY l.tanggal_lembur DESC`;

        const hasil = await db.query(queryTeks, params);
        res.json(hasil.rows);
    } catch (error) { res.status(500).json({ pesan: "Gagal mengambil data." }); }
});

app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});
// Tambahkan baris ini di paling bawah file server.js
module.exports = app;
