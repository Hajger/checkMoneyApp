const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 1. SESSION SETUP
app.use(session({
    secret: 'secret_key_checkmoney_123', // In production, use environment variables for secrets
    resave: false,
    saveUninitialized: false
}));

// Smart path detection: Fly.io volume vs Localhost
const dbPath = process.env.FLY_APP_NAME ? '/data/checkmoney.db' : './checkmoney.db';
const db = new sqlite3.Database(dbPath);

// 2. DATABASE INITIALIZATION (Users & Subscriptions)
db.serialize(() => {
    // Create Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`);

    // Create Subscriptions table with user_id foreign key
    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        currency TEXT NOT NULL,
        billing_period TEXT NOT NULL,
        next_payment_date TEXT NOT NULL,
        free_trial_end_date TEXT,
        category TEXT DEFAULT 'Other',
        user_id INTEGER NOT NULL
    )`);

    // Attempt to add user_id column if migrating from an older database version
    db.run("ALTER TABLE subscriptions ADD COLUMN user_id INTEGER", (err) => {
        // We intentionally ignore errors here. If the column exists, it throws an error we don't care about.
    });
});

const exchangeRates = { CZK: 1, EUR: 25, USD: 23 };

// 3. AUTHENTICATION MIDDLEWARE
// Add this before any route that requires the user to be logged in
const requireLogin = (req, res, next) => {
    if (req.session.userId) {
        next(); // User is logged in, proceed to the requested page
    } else {
        res.redirect('/login'); // Not logged in, redirect to login page
    }
};

// --- LOGIN & REGISTRATION ROUTES ---

app.get('/login', (req, res) => res.render('login'));
app.get('/register', (req, res) => res.render('register'));

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.render('register', { error: 'Please fill in all fields.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10); // Encrypt the password
        
        db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], function(err) {
            if (err) {
                return res.render('register', { error: 'Username already exists. Please choose another one.' });
            }
            res.redirect('/login');
        });
    } catch (e) {
        res.render('register', { error: 'An error occurred during registration. Please try again.' });
    }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        // Standard security practice: Don't specify whether the username or password was wrong
        if (err || !user) {
            return res.render('login', { error: 'Invalid username or password.' });
        }
        
        const isMatch = await bcrypt.compare(password, user.password); // Verify password hash
        
        if (isMatch) {
            req.session.userId = user.id; // Create session ticket
            res.redirect('/');
        } else {
            res.render('login', { error: 'Invalid username or password.' });
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(); // Destroy session ticket
    res.redirect('/login');
});


// --- MAIN APPLICATION ROUTES (Protected by requireLogin) ---

app.get('/', requireLogin, (req, res) => {
    const filterCategory = req.query.category || 'All';
    const sortBy = req.query.sort || 'date_asc';
    const primaryCurrency = req.query.currency || 'CZK';

    // Fetch ONLY the subscriptions belonging to the logged-in user
    let query = 'SELECT * FROM subscriptions WHERE user_id = ?';
    let params = [req.session.userId];

    if (filterCategory !== 'All') {
        query += ' AND category = ?';
        params.push(filterCategory);
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).send("Database error occurred while fetching subscriptions.");

        let totalCZK = 0, totalEUR = 0, totalUSD = 0, grandTotal = 0;
        const today = new Date();

        rows.forEach(row => {
            let priceInCZK = row.price * exchangeRates[row.currency];
            row.normalizedPrice = priceInCZK / exchangeRates[primaryCurrency];

            let monthlyCost = row.price;
            if (row.billing_period === 'yearly') monthlyCost = row.price / 12;

            let isFreeTrial = false;
            if (row.free_trial_end_date && new Date(row.free_trial_end_date) >= today) {
                isFreeTrial = true;
            }

            if (!isFreeTrial) {
                if (row.currency === 'CZK') totalCZK += monthlyCost;
                if (row.currency === 'EUR') totalEUR += monthlyCost;
                if (row.currency === 'USD') totalUSD += monthlyCost;
                grandTotal += ((monthlyCost * exchangeRates[row.currency]) / exchangeRates[primaryCurrency]);
            }
        });

        // Sorting logic
        if (sortBy === 'date_asc') rows.sort((a, b) => new Date(a.next_payment_date) - new Date(b.next_payment_date));
        else if (sortBy === 'price_desc') rows.sort((a, b) => b.normalizedPrice - a.normalizedPrice);
        else if (sortBy === 'price_asc') rows.sort((a, b) => a.normalizedPrice - b.normalizedPrice);
        else if (sortBy === 'name_asc') rows.sort((a, b) => a.name.localeCompare(b.name));

        res.render('index', { 
            subscriptions: rows, 
            totalCZK: totalCZK.toFixed(2), 
            totalEUR: totalEUR.toFixed(2),
            totalUSD: totalUSD.toFixed(2), 
            grandTotal: grandTotal.toFixed(2),
            filterCategory, 
            sortBy, 
            primaryCurrency, 
            exchangeRates
        });
    });
});

app.post('/add', requireLogin, (req, res) => {
    let { name, price, currency, billing_period, next_payment_date, free_trial_end_date, category } = req.body;
    free_trial_end_date = free_trial_end_date ? free_trial_end_date : null;
    category = category || 'Other';

    const sql = 'INSERT INTO subscriptions (name, price, currency, billing_period, next_payment_date, free_trial_end_date, category, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    db.run(sql, [name, price, currency, billing_period, next_payment_date, free_trial_end_date, category, req.session.userId], (err) => {
        if (err) console.error("Error adding subscription:", err.message);
        res.redirect('/');
    });
});

app.post('/delete', requireLogin, (req, res) => {
    // Ensure the user can only delete THEIR OWN subscriptions
    db.run('DELETE FROM subscriptions WHERE id = ? AND user_id = ?', [req.body.id, req.session.userId], (err) => {
        if (err) console.error("Error deleting subscription:", err.message);
        res.redirect('/');
    });
});

app.get('/edit/:id', requireLogin, (req, res) => {
    // Ensure the user can only edit THEIR OWN subscriptions
    db.get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err, row) => {
        if (err || !row) return res.redirect('/');
        res.render('edit', { subscription: row });
    });
});

app.post('/edit/:id', requireLogin, (req, res) => {
    let { name, price, currency, billing_period, next_payment_date, free_trial_end_date, category } = req.body;
    free_trial_end_date = free_trial_end_date ? free_trial_end_date : null;
    category = category || 'Other';

    const sql = 'UPDATE subscriptions SET name = ?, price = ?, currency = ?, billing_period = ?, next_payment_date = ?, free_trial_end_date = ?, category = ? WHERE id = ? AND user_id = ?';
    db.run(sql, [name, price, currency, billing_period, next_payment_date, free_trial_end_date, category, req.params.id, req.session.userId], (err) => {
        if (err) console.error("Error updating subscription:", err.message);
        res.redirect('/');
    });
});

app.post('/renew', requireLogin, (req, res) => {
    db.get('SELECT next_payment_date, billing_period FROM subscriptions WHERE id = ? AND user_id = ?', [req.body.id, req.session.userId], (err, row) => {
        if (err || !row) {
            console.error("Subscription not found for renewal.");
            return res.redirect('/');
        }

        let currentDate = new Date(row.next_payment_date);
        if (row.billing_period === 'yearly') {
            currentDate.setFullYear(currentDate.getFullYear() + 1);
        } else {
            currentDate.setMonth(currentDate.getMonth() + 1);
        }

        const newDateString = currentDate.toISOString().split('T')[0];

        db.run('UPDATE subscriptions SET next_payment_date = ? WHERE id = ?', [newDateString, req.body.id], (err) => {
            if (err) console.error("Error renewing subscription:", err.message);
            res.redirect('/');
        });
    });
});

app.listen(port, '0.0.0.0', () => console.log(`Web server is running on port: http://localhost:${port}`));