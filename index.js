const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const app = express();
// Port nyni vezmeme z prostredi serveru, nebo pouzijeme 3000 u tebe na PC
const port = process.env.PORT || 3000; 

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Chytra detekce: Pokud jsme na Fly.io, ulozime databazi na novy pevny disk (/data)
const dbPath = process.env.FLY_APP_NAME ? '/data/checkmoney.db' : './checkmoney.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        currency TEXT NOT NULL,
        billing_period TEXT NOT NULL,
        next_payment_date TEXT NOT NULL,
        free_trial_end_date TEXT,
        category TEXT DEFAULT 'Other'
    )`);
});

const exchangeRates = {
    CZK: 1,
    EUR: 25,
    USD: 23
};

app.get('/', (req, res) => {
    const filterCategory = req.query.category || 'All';
    const sortBy = req.query.sort || 'date_asc';
    const primaryCurrency = req.query.currency || 'CZK';

    let query = 'SELECT * FROM subscriptions';
    let params = [];

    if (filterCategory !== 'All') {
        query += ' WHERE category = ?';
        params.push(filterCategory);
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).send("Error reading from the database.");
            return;
        }

        let totalCZK = 0;
        let totalEUR = 0;
        let totalUSD = 0;
        let grandTotal = 0;
        const today = new Date();

        rows.forEach(row => {
            let priceInCZK = row.price * exchangeRates[row.currency];
            row.normalizedPrice = priceInCZK / exchangeRates[primaryCurrency];

            let monthlyCost = row.price;
            if (row.billing_period === 'yearly') {
                monthlyCost = row.price / 12;
            }

            let isFreeTrial = false;
            if (row.free_trial_end_date) {
                const trialEnd = new Date(row.free_trial_end_date);
                if (trialEnd >= today) {
                    isFreeTrial = true;
                }
            }

            if (!isFreeTrial) {
                if (row.currency === 'CZK') totalCZK += monthlyCost;
                if (row.currency === 'EUR') totalEUR += monthlyCost;
                if (row.currency === 'USD') totalUSD += monthlyCost;

                let monthlyInCZK = monthlyCost * exchangeRates[row.currency];
                grandTotal += (monthlyInCZK / exchangeRates[primaryCurrency]);
            }
        });

        if (sortBy === 'date_asc') {
            rows.sort((a, b) => new Date(a.next_payment_date) - new Date(b.next_payment_date));
        } else if (sortBy === 'price_desc') {
            rows.sort((a, b) => b.normalizedPrice - a.normalizedPrice);
        } else if (sortBy === 'price_asc') {
            rows.sort((a, b) => a.normalizedPrice - b.normalizedPrice);
        } else if (sortBy === 'name_asc') {
            rows.sort((a, b) => a.name.localeCompare(b.name));
        }

        res.render('index', { 
            subscriptions: rows,
            totalCZK: totalCZK.toFixed(2),
            totalEUR: totalEUR.toFixed(2),
            totalUSD: totalUSD.toFixed(2),
            grandTotal: grandTotal.toFixed(2),
            filterCategory: filterCategory,
            sortBy: sortBy,
            primaryCurrency: primaryCurrency,
            exchangeRates: exchangeRates
        });
    });
});

app.post('/add', (req, res) => {
    let { name, price, currency, billing_period, next_payment_date, free_trial_end_date, category } = req.body;
    free_trial_end_date = free_trial_end_date ? free_trial_end_date : null;
    category = category || 'Other';

    const sql = 'INSERT INTO subscriptions (name, price, currency, billing_period, next_payment_date, free_trial_end_date, category) VALUES (?, ?, ?, ?, ?, ?, ?)';
    
    db.run(sql, [name, price, currency, billing_period, next_payment_date, free_trial_end_date, category], (err) => {
        if (err) console.error(err.message);
        res.redirect('/');
    });
});

app.post('/delete', (req, res) => {
    const idToDelete = req.body.id;
    const sql = 'DELETE FROM subscriptions WHERE id = ?';
    
    db.run(sql, [idToDelete], (err) => {
        if (err) console.error(err.message);
        res.redirect('/');
    });
});

app.get('/edit/:id', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM subscriptions WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            console.error(err ? err.message : "Not found");
            res.redirect('/');
            return;
        }
        res.render('edit', { subscription: row });
    });
});

app.post('/edit/:id', (req, res) => {
    const id = req.params.id;
    let { name, price, currency, billing_period, next_payment_date, free_trial_end_date, category } = req.body;
    free_trial_end_date = free_trial_end_date ? free_trial_end_date : null;
    category = category || 'Other';

    const sql = 'UPDATE subscriptions SET name = ?, price = ?, currency = ?, billing_period = ?, next_payment_date = ?, free_trial_end_date = ?, category = ? WHERE id = ?';
    
    db.run(sql, [name, price, currency, billing_period, next_payment_date, free_trial_end_date, category, id], (err) => {
        if (err) console.error(err.message);
        res.redirect('/');
    });
});

app.post('/renew', (req, res) => {
    const id = req.body.id;
    
    db.get('SELECT next_payment_date, billing_period FROM subscriptions WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            console.error("Zaznam nenalezen");
            res.redirect('/');
            return;
        }

        let currentDate = new Date(row.next_payment_date);
        
        if (row.billing_period === 'yearly') {
            currentDate.setFullYear(currentDate.getFullYear() + 1);
        } else {
            currentDate.setMonth(currentDate.getMonth() + 1);
        }

        const newDateString = currentDate.toISOString().split('T')[0];

        db.run('UPDATE subscriptions SET next_payment_date = ? WHERE id = ?', [newDateString, id], (err) => {
            if (err) console.error(err.message);
            res.redirect('/');
        });
    });
});

// Zmena na 0.0.0.0 zajisti dostupnost z internetu
app.listen(port, '0.0.0.0', () => {
    console.log(`Web server is running on port: ${port}`);
});