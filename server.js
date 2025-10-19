const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const mqtt = require('mqtt');
const axios = require('axios');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let cfg = loadConfig();

// ensure dataDir exists
if (!fs.existsSync(cfg.dataDir)) fs.mkdirSync(cfg.dataDir, { recursive: true });

const app = express();
app.use(express.json());
app.use(require('cors')());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = socketio(server);

// helper: normalize topic -> filename safe
function topicFile(topic) {
  // replace slashes with double underscore
  return path.join(cfg.dataDir, encodeURIComponent(topic) + '.json');
}

// load history (array of {t: timestamp_ms, v: value})
function appendReading(topic, value) {
  const file = topicFile(topic);
  let arr = [];
  try {
    if (fs.existsSync(file)) {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read history file', e);
    arr = [];
  }
  const entry = { t: Date.now(), v: value };
  arr.push(entry);
  // prune older than retainDays
  const cutoff = Date.now() - (cfg.retainDays || 7) * 24 * 3600 * 1000;
  arr = arr.filter(e => e.t >= cutoff);
  try {
    fs.writeFileSync(file, JSON.stringify(arr));
  } catch (e) {
    console.error('Failed to write history file', e);
  }
}

function getHistory(topic) {
  const file = topicFile(topic);
  try {
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('getHistory error', e);
    return [];
  }
}

// manage subscriptions based on cfg.topics
let mqttClient = null;
let currentSubscriptions = new Set();

// create mqtt client and handle messages
function connectMqtt() {
  if (mqttClient) {
    try { mqttClient.end(); } catch (e){}
    mqttClient = null;
    currentSubscriptions.clear();
  }
  console.log('[MQTT] connecting to', cfg.broker);
  mqttClient = mqtt.connect(cfg.broker, { reconnectPeriod: 5000 });

  mqttClient.on('connect', () => {
    console.log('[MQTT] connected');
    // subscribe to topics from config
    cfg.topics.forEach(t => {
      if (!currentSubscriptions.has(t.topic)) {
        mqttClient.subscribe(t.topic, err => {
          if (!err) {
            currentSubscriptions.add(t.topic);
            console.log('[MQTT] subscribed', t.topic);
          } else {
            console.error('[MQTT] subscribe error', t.topic, err);
          }
        });
      }
    });
  });

  mqttClient.on('message', (topic, payload) => {
    const str = payload.toString();
    let numeric = Number(str);
    const value = isFinite(numeric) ? numeric : str;
    // save locally
    appendReading(topic, value);
    // determine state if numeric and threshold present
    const topicCfg = cfg.topics.find(t => t.topic === topic);
    let state = { name: 'unknown', priority: 0 };
    if (topicCfg && typeof topicCfg.threshold !== 'undefined' && typeof numeric === 'number' && isFinite(numeric)) {
      const x = Number(topicCfg.threshold);
      if (numeric > x) {
        state = { name: 'critical', priority: 2 };
      } else if (numeric >= x) {
        state = { name: 'awaryjny', priority: 1 };
      } else {
        state = { name: 'normal', priority: 0 };
      }
    } else {
      // non-numeric -> keep normal with priority 0
      state = { name: 'normal', priority: 0 };
    }

    // send to clients
    io.emit('mqtt_message', { topic, value, state, ts: Date.now() });

    // handle Pushover notifications on state change
    if (cfg.pushover && cfg.pushover.enabled && topicCfg) {
      // read last known state per topic from memory file
      const stateFile = path.join(cfg.dataDir, encodeURIComponent(topic) + '.state.json');
      let prevState = null;
      try {
        if (fs.existsSync(stateFile)) prevState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch(e){ prevState = null; }
      const prevName = prevState && prevState.name ? prevState.name : null;

      // send notification only if state changed
      if (prevName !== state.name) {
        sendPushoverNotification(topic, value, state).catch(err => {
          console.error('Pushover error', err && err.message ? err.message : err);
        });
        // save new state
        try { fs.writeFileSync(stateFile, JSON.stringify({ name: state.name, ts: Date.now() })); } catch(e){}
      }
    }
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT] error', err.message);
  });

  mqttClient.on('reconnect', () => {
    console.log('[MQTT] reconnecting...');
  });

  mqttClient.on('close', () => {
    console.log('[MQTT] connection closed');
  });
}

async function sendPushoverNotification(topic, value, state) {
  if (!cfg.pushover || !cfg.pushover.enabled) return;
  if (!cfg.pushover.token || !cfg.pushover.user) return;
  // compose message: use topic components as <hostname><device><sensor>
  const comps = topic.split('/');
  const hostname = os.hostname();
  const device = comps[0] || '';
  const sensor = comps.slice(1).join('/') || '';
  const message = `${hostname} ${device} ${sensor} ${state.name} value=${value}`;
  const priority = state.priority;

  // use axios to post form
  const form = new URLSearchParams();
  form.append('token', cfg.pushover.token);
  form.append('user', cfg.pushover.user);
  form.append('message', message);
  form.append('priority', String(priority));
  await axios.post('https://api.pushover.net/1/messages.json', form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 8000
  });
  console.log('[Pushover] sent', topic, state.name);
}

// initial connect
connectMqtt();

// API endpoints

// get full config view for frontend
app.get('/api/config', (req, res) => {
  res.json({ broker: cfg.broker, port: cfg.port, topics: cfg.topics, pushover: cfg.pushover });
});

// add subscription
app.post('/api/subscribe', (req, res) => {
  const { topic, threshold } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  if (cfg.topics.find(t => t.topic === topic)) return res.status(400).json({ error: 'already subscribed' });
  const entry = { topic, hidden: false };
  if (typeof threshold !== 'undefined') entry.threshold = threshold;
  cfg.topics.push(entry);
  saveConfig(cfg);
  // subscribe now
  if (mqttClient) {
    mqttClient.subscribe(topic, err => {
      if (!err) {
        currentSubscriptions.add(topic);
        console.log('[MQTT] subscribed', topic);
      }
    });
  }
  res.json({ ok: true, topics: cfg.topics });
});

// unsubscribe
app.post('/api/unsubscribe', (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  cfg.topics = cfg.topics.filter(t => t.topic !== topic);
  saveConfig(cfg);
  if (mqttClient) {
    mqttClient.unsubscribe(topic, err => {
      if (!err) {
        currentSubscriptions.delete(topic);
        console.log('[MQTT] unsubscribed', topic);
      }
    });
  }
  res.json({ ok: true, topics: cfg.topics });
});

// toggle hidden
app.post('/api/toggle-hidden', (req, res) => {
  const { topic } = req.body;
  const t = cfg.topics.find(x => x.topic === topic);
  if (!t) return res.status(404).json({ error: 'topic not found' });
  t.hidden = !t.hidden;
  saveConfig(cfg);
  res.json({ ok: true, topic: t });
});

// set threshold
app.post('/api/set-threshold', (req, res) => {
  const { topic, threshold } = req.body;
  const t = cfg.topics.find(x => x.topic === topic);
  if (!t) return res.status(404).json({ error: 'topic not found' });
  if (threshold === null || threshold === undefined || threshold === '') {
    delete t.threshold;
  } else {
    t.threshold = Number(threshold);
  }
  saveConfig(cfg);
  res.json({ ok: true, topic: t });
});

// get history
app.get('/api/history', (req, res) => {
  const topic = req.query.topic;
  if (!topic) return res.status(400).json({ error: 'topic required' });
  const arr = getHistory(topic);
  res.json(arr);
});

// endpoint to reload config (optional)
app.post('/api/reload-config', (req, res) => {
  try {
    cfg = loadConfig();
    connectMqtt();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// pruning old data daily
function pruneAll() {
  const cutoff = Date.now() - (cfg.retainDays || 7) * 24 * 3600 * 1000;
  fs.readdir(cfg.dataDir, (err, files) => {
    if (err) return;
    files.forEach(f => {
      if (!f.endsWith('.json')) return;
      const p = path.join(cfg.dataDir, f);
      try {
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!Array.isArray(arr)) return;
        const newArr = arr.filter(e => e.t >= cutoff);
        if (newArr.length !== arr.length) {
          fs.writeFileSync(p, JSON.stringify(newArr));
        }
      } catch (e) {}
    });
  });
}
// run prune every hour as well as on startup
pruneAll();
setInterval(pruneAll, 60*60*1000);

// Socket.io connections
io.on('connection', (socket) => {
  console.log('[IO] client connected', socket.id);
  // send initial topics and last values (read last from history)
  const topicsInfo = cfg.topics.map(t => {
    const hist = getHistory(t.topic);
    const last = hist.length ? hist[hist.length - 1].v : null;
    return { ...t, last };
  });
  socket.emit('init', { topics: topicsInfo });
});

// start server
server.listen(cfg.port || 3000, () => {
  console.log('Server started on port', cfg.port || 3000);
});