const socket = io();
let topics = {}; // map topic -> element and chart data

function createTopicElement(t) {
  const tpl = document.getElementById('topic-template');
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.topic = t.topic;
  el.querySelector('.topic-title').textContent = t.topic;
  el.querySelector('.topic-last').textContent = t.last !== null && t.last !== undefined ? t.last : '';
  const btnHist = el.querySelector('.btn-history');
  const btnHide = el.querySelector('.btn-toggle-hide');
  const btnUnsub = el.querySelector('.btn-unsub');
  const body = el.querySelector('.topic-body');
  const threshInput = el.querySelector('.input-threshold');
  const chartWrap = el.querySelector('.chart-wrap');
  const canvas = chartWrap.querySelector('canvas');

  threshInput.value = t.threshold !== undefined ? t.threshold : '';

  if (t.hidden) el.style.display = 'none';
  else el.style.display = '';

  // chart
  let chart = null;

  btnHist.addEventListener('click', async () => {
    if (chartWrap.style.display === 'none') {
      // load history
      const res = await fetch('/api/history?topic=' + encodeURIComponent(t.topic));
      const arr = await res.json();
      const labels = arr.map(e => new Date(e.t).toLocaleTimeString());
      const data = arr.map(e => typeof e.v === 'number' ? e.v : NaN);
      chartWrap.style.display = '';
      body.style.display = '';
      btnHist.textContent = 'Hide Chart';
      if (chart) {
        chart.data.labels = labels;
        chart.data.datasets[0].data = data;
        chart.update();
      } else {
        chart = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: t.topic,
              data,
              borderColor: '#3498db',
              borderWidth: 1,
              pointRadius: 0,
              tension: 0.3
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { x: { display: false }, y: { display: false } },
            plugins: { legend: { display: false } }
          }
        });
      }
    } else {
      chartWrap.style.display = 'none';
      btnHist.textContent = 'Show Chart';
    }
  });

  btnHide.addEventListener('click', async () => {
    // toggle hide via API
    await fetch('/api/toggle-hidden', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: t.topic })
    });
    if (el.style.display === 'none') el.style.display = '';
    else el.style.display = 'none';
  });

  btnUnsub.addEventListener('click', async () => {
    if (!confirm('Unsubscribe from ' + t.topic + '?')) return;
    await fetch('/api/unsubscribe', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ topic: t.topic })
    });
    // remove from DOM
    el.remove();
    delete topics[t.topic];
  });

  threshInput.addEventListener('change', async () => {
    const val = threshInput.value;
    await fetch('/api/set-threshold', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ topic: t.topic, threshold: val })
    });
    // no immediate UI change
  });

  return { el, update: (payload) => {
    const lastSpan = el.querySelector('.topic-last');
    lastSpan.textContent = payload.value;
    // color by state
    if (payload.state) {
      if (payload.state.name === 'critical') el.style.borderColor = '#e74c3c';
      else if (payload.state.name === 'awaryjny') el.style.borderColor = '#f39c12';
      else el.style.borderColor = '#e2e6ef';
    }
    // update chart if shown
    if (chart) {
      chart.data.labels.push(new Date(payload.ts).toLocaleTimeString());
      chart.data.datasets[0].data.push(typeof payload.value === 'number' ? payload.value : NaN);
      // keep only recent points
      if (chart.data.labels.length > 200) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
      }
      chart.update('none');
    }
  }};
}

function buildTree(list) {
  const container = document.getElementById('tree');
  container.innerHTML = '';
  list.forEach(t => {
    const node = createTopicElement(t);
    topics[t.topic] = node;
    container.appendChild(node.el);
  });
}

document.getElementById('btnSubscribe').addEventListener('click', async () => {
  const topic = document.getElementById('newTopic').value.trim();
  const threshold = document.getElementById('newThreshold').value.trim();
  if (!topic) return alert('Enter topic');
  const res = await fetch('/api/subscribe', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ topic, threshold: threshold === '' ? undefined : threshold })
  });
  const json = await res.json();
  if (res.ok) {
    // reload list
    init();
    document.getElementById('newTopic').value = '';
    document.getElementById('newThreshold').value = '';
  } else {
    alert(json.error || 'Error subscribing');
  }
});

document.getElementById('btnReload').addEventListener('click', async () => {
  await fetch('/api/reload-config', { method: 'POST' });
  init();
});

async function init() {
  const res = await fetch('/api/config');
  const json = await res.json();
  // build initial tree
  buildTree(json.topics.map(t => ({ ...t, last: t.last || null })));
}

socket.on('connect', () => {
  console.log('socket connected');
});
socket.on('init', (data) => {
  // if server sends initial topics
  if (data && data.topics) {
    buildTree(data.topics);
  }
});
socket.on('mqtt_message', (payload) => {
  // payload: { topic, value, state, ts }
  const t = topics[payload.topic];
  if (t) t.update(payload);
  else {
    // new topic not in UI -> optionally add
    // simple auto-add: create element
    const newTopic = { topic: payload.topic, hidden: false, last: payload.value };
    const node = createTopicElement(newTopic);
    topics[newTopic.topic] = node;
    document.getElementById('tree').appendChild(node.el);
    node.update(payload);
  }
});

init();