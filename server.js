const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

const app = express();
const PORT = 3003;

// Ścieżki do plików
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const THRESHOLDS_FILE = path.join(__dirname, 'thresholds.json');

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// Główna trasa - serwuj index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Domyślna konfiguracja
const DEFAULT_CONFIG = {
    broker: 'ws://10.10.0.4:9002',
    topics: ['sensors/#'],
    pushover: {
        token: 'akd8sqxoo4q17qv72g62v4wyu7ufem',
        user: 'uuf2ajfth5tayjcser9wy8wuux6ncz'
    }
};

// Inicjalizacja katalogów
async function initDirectories() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        console.log('Katalog data utworzony/istnieje');
    } catch (error) {
        console.error('Błąd tworzenia katalogów:', error);
    }
}

// Ładowanie konfiguracji
async function loadConfig() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.log('Tworzenie domyślnej konfiguracji');
        await saveConfig(DEFAULT_CONFIG);
        return DEFAULT_CONFIG;
    }
}

// Zapisywanie konfiguracji
async function saveConfig(config) {
    try {
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        console.error('Błąd zapisu konfiguracji:', error);
        return false;
    }
}

// Ładowanie progów
async function loadThresholds() {
    try {
        const data = await fs.readFile(THRESHOLDS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

// Zapisywanie progów
async function saveThresholds(thresholds) {
    try {
        await fs.writeFile(THRESHOLDS_FILE, JSON.stringify(thresholds, null, 2));
        return true;
    } catch (error) {
        console.error('Błąd zapisu progów:', error);
        return false;
    }
}

// API: Pobierz konfigurację
app.get('/api/config', async (req, res) => {
    try {
        const config = await loadConfig();
        const thresholds = await loadThresholds();
        res.json({ ...config, thresholds });
    } catch (error) {
        res.status(500).json({ error: 'Błąd ładowania konfiguracji' });
    }
});

// API: Zapisz konfigurację
app.post('/api/config', async (req, res) => {
    try {
        const success = await saveConfig(req.body);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Błąd zapisu konfiguracji' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Błąd zapisu konfiguracji' });
    }
});

// API: Zapisz dane MQTT
app.post('/api/data', async (req, res) => {
    try {
        const { topic, value, timestamp } = req.body;
        const date = new Date(timestamp);
        const dateStr = date.toISOString().split('T')[0];
        
        const fileName = path.join(DATA_DIR, `${dateStr}.jsonl`);
        const line = JSON.stringify({ topic, value, timestamp }) + '\n';
        
        await fs.appendFile(fileName, line);
        res.json({ success: true });
    } catch (error) {
        console.error('Błąd zapisu danych:', error);
        res.status(500).json({ error: 'Błąd zapisu danych' });
    }
});

// API: Wyczyść stare dane (starsze niż 7 dni)
app.post('/api/data/clean', async (req, res) => {
    try {
        const files = await fs.readdir(DATA_DIR);
        const now = Date.now();
        const sevenDays = 7 * 24 * 60 * 60 * 1000;
        
        for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            
            const filePath = path.join(DATA_DIR, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > sevenDays) {
                await fs.unlink(filePath);
                console.log(`Usunięto stary plik: ${file}`);
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Błąd czyszczenia danych:', error);
        res.status(500).json({ error: 'Błąd czyszczenia danych' });
    }
});

// API: Pobierz historyczne dane
app.get('/api/data/:topic', async (req, res) => {
    try {
        const topic = req.params.topic;
        const days = parseInt(req.query.days) || 7;
        const allData = [];
        
        const files = await fs.readdir(DATA_DIR);
        const now = Date.now();
        const maxAge = days * 24 * 60 * 60 * 1000;
        
        for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            
            const filePath = path.join(DATA_DIR, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() <= maxAge) {
                const content = await fs.readFile(filePath, 'utf8');
                const lines = content.trim().split('\n');
                
                for (const line of lines) {
                    try {
                        const data = JSON.parse(line);
                        if (data.topic === topic) {
                            allData.push(data);
                        }
                    } catch (e) {
                        // Ignoruj błędne linie
                    }
                }
            }
        }
        
        res.json(allData);
    } catch (error) {
        console.error('Błąd odczytu danych:', error);
        res.status(500).json({ error: 'Błąd odczytu danych' });
    }
});

// API: Zapisz progi dla topica
app.post('/api/thresholds', async (req, res) => {
    try {
        const { topic, thresholds } = req.body;
        const allThresholds = await loadThresholds();
        
        allThresholds[topic] = thresholds;
        
        const success = await saveThresholds(allThresholds);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Błąd zapisu progów' });
        }
    } catch (error) {
        console.error('Błąd zapisu progów:', error);
        res.status(500).json({ error: 'Błąd zapisu progów' });
    }
});

// API: Wyślij powiadomienie Pushover
app.post('/api/notify', async (req, res) => {
    try {
        const { message, priority, topic } = req.body;
        const config = await loadConfig();
        
        const curlCommand = `curl -s \
            -F "token=${config.pushover.token}" \
            -F "user=${config.pushover.user}" \
            -F "message=${message}" \
            -F "priority=${priority}" \
            https://api.pushover.net/1/messages.json`;
        
        const { stdout, stderr } = await execPromise(curlCommand);
        
        if (stderr) {
            console.error('Błąd Pushover:', stderr);
            return res.status(500).json({ error: 'Błąd wysyłania powiadomienia' });
        }
        
        console.log(`Powiadomienie wysłane dla ${topic}: ${message}`);
        res.json({ success: true, response: stdout });
    } catch (error) {
        console.error('Błąd wysyłania powiadomienia:', error);
        res.status(500).json({ error: 'Błąd wysyłania powiadomienia' });
    }
});

// Uruchomienie serwera
async function startServer() {
    await initDirectories();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 MQTT Dashboard uruchomiony na:`);
        console.log(`   - Lokalnie: http://localhost:${PORT}`);
        console.log(`   - W sieci lokalnej: http://[TWOJE_IP]:${PORT}`);
        console.log(`📁 Dane przechowywane w: ${DATA_DIR}`);
    });
}

startServer();
