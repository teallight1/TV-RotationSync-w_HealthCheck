// ===========================
// TRADINGVIEW SYNC SERVER v2
// With browser tracking for Sync+Alerts extension
// ===========================

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ===========================
// STATE
// ===========================

let syncState = {
  leaderId: null,
  leaderHeartbeat: 0,
  currentIndex: 0,
  rotateInterval: 7,
  fetchInterval: 120,
  colLInterval: 10,
  selectedFilters: ['Comfortable'],
  filteredData: [],
  alertSettings: {}
};

// Browser tracking - key: browserId, value: { lastSeen, isLeader, tf }
let connectedBrowsers = {};

// Clean up stale browsers every 10 seconds
const BROWSER_TIMEOUT = 30000; // 30 seconds without heartbeat = offline (was 15s)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [browserId, info] of Object.entries(connectedBrowsers)) {
    if (now - info.lastSeen > BROWSER_TIMEOUT) {
      delete connectedBrowsers[browserId];
      cleaned++;
      
      // If leader went offline, clear leadership
      if (syncState.leaderId === browserId) {
        console.log(`👑 Leader ${browserId.slice(-8)} went offline, clearing leadership`);
        syncState.leaderId = null;
        syncState.leaderHeartbeat = 0;
      }
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} stale browser(s). Active: ${Object.keys(connectedBrowsers).length}`);
  }
}, 10000);

// ===========================
// HELPER FUNCTIONS
// ===========================

function getBrowserStats() {
  const now = Date.now();
  const browsers = Object.entries(connectedBrowsers).map(([id, info]) => {
    const isLeader = syncState.leaderId === id;
    const secondsAgo = Math.round((now - info.lastSeen) / 1000);
    
    // Determine status based on last seen time and leader status
    let status = 'online';
    if (isLeader) {
      status = 'leader';
    } else if (secondsAgo > 10) {
      status = 'warning';
    } else if (secondsAgo > 20) {
      status = 'offline';
    }
    
    return {
      id: id.slice(-8),
      browserId: id,
      isLeader: isLeader,
      status: status,
      lastSeen: secondsAgo + 's ago',
      tf: info.tf || '5'
    };
  });
  
  return {
    totalBrowsers: browsers.length,
    browsersOnline: browsers.filter(b => b.status !== 'offline').length,
    browsersList: browsers
  };
}

function registerBrowser(browserId, tf) {
  connectedBrowsers[browserId] = {
    lastSeen: Date.now(),
    tf: tf || '5'
  };
}

// ===========================
// ENDPOINTS
// ===========================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    version: '2.2.0',
    browsers: Object.keys(connectedBrowsers).length,
    leader: syncState.leaderId ? syncState.leaderId.slice(-8) : 'none'
  });
});

// GET /sync-state - Read current state + browser stats
app.get('/sync-state', (req, res) => {
  const browserId = req.query.browserId;
  const tf = req.query.tf;
  
  // Register browser heartbeat if provided
  if (browserId) {
    registerBrowser(browserId, tf);
  }
  
  const browserStats = getBrowserStats();
  
  console.log(`📡 GET /sync-state from ${browserId?.slice(-8) || 'unknown'} (tf=${tf || '?'}), browsers: ${browserStats.browsersOnline}/${browserStats.totalBrowsers}`);
  
  res.json({
    ...syncState,
    ...browserStats
  });
});

// POST /sync-state - Leader sends heartbeat updates
app.post('/sync-state', (req, res) => {
  const { leaderId, leaderHeartbeat, ...rest } = req.body;
  
  // Register leader browser
  if (leaderId) {
    registerBrowser(leaderId, req.body.tf);
  }
  
  // Only update leadership heartbeat if sender IS the current leader
  if (leaderId && leaderId === syncState.leaderId) {
    syncState.leaderHeartbeat = leaderHeartbeat || Date.now();
  }
  
  // Update other sync state (symbol, position, etc) - but NOT leaderId
  const { leaderId: _, leaderHeartbeat: __, ...stateUpdates } = rest;
  syncState = { 
    ...syncState, 
    ...stateUpdates
  };
  
  const browserStats = getBrowserStats();
  
  res.json({ 
    success: true,
    ...browserStats
  });
});

// POST /claim-leader - Browser claims leadership
app.post('/claim-leader', (req, res) => {
  const { browserId, timestamp, force, tf } = req.body;
  
  if (!browserId) {
    return res.status(400).json({ success: false, error: 'browserId required' });
  }
  
  // Register browser
  registerBrowser(browserId, tf);
  
  const shortId = browserId.slice(-8);
  const currentLeaderShort = syncState.leaderId ? syncState.leaderId.slice(-8) : 'none';
  
  // Force claim always succeeds
  if (force) {
    console.log(`⚡ FORCE claim by ${shortId}`);
    syncState.leaderId = browserId;
    syncState.leaderHeartbeat = timestamp || Date.now();
    return res.json({ 
      success: true, 
      leaderId: browserId,
      ...getBrowserStats()
    });
  }
  
  // Check if no leader or leader timed out
  const timeSinceHeartbeat = Date.now() - syncState.leaderHeartbeat;
  const leaderTimeout = 8000; // 8 seconds - must match extension LEADER_TIMEOUT
  
  if (!syncState.leaderId || timeSinceHeartbeat > leaderTimeout) {
    console.log(`👑 ${shortId} claimed leadership (previous: ${currentLeaderShort}, timeout: ${timeSinceHeartbeat}ms)`);
    syncState.leaderId = browserId;
    syncState.leaderHeartbeat = timestamp || Date.now();
    return res.json({ 
      success: true, 
      leaderId: browserId,
      ...getBrowserStats()
    });
  }
  
  // Check if this browser is already the leader (re-claim)
  if (syncState.leaderId === browserId) {
    syncState.leaderHeartbeat = timestamp || Date.now();
    return res.json({ 
      success: true, 
      leaderId: browserId,
      ...getBrowserStats()
    });
  }
  
  // Leader exists and active
  res.json({ 
    success: false, 
    leaderId: syncState.leaderId,
    reason: `Leader ${currentLeaderShort} is active`,
    ...getBrowserStats()
  });
});

// POST /heartbeat - Simple heartbeat from any browser
app.post('/heartbeat', (req, res) => {
  const { browserId, tf, isLeader } = req.body;
  
  if (!browserId) {
    return res.status(400).json({ success: false, error: 'browserId required' });
  }
  
  registerBrowser(browserId, tf);
  
  // If this is the leader, update heartbeat
  if (isLeader && syncState.leaderId === browserId) {
    syncState.leaderHeartbeat = Date.now();
  }
  
  res.json({ 
    success: true,
    ...getBrowserStats()
  });
});

// GET /browsers - Get list of connected browsers
app.get('/browsers', (req, res) => {
  res.json(getBrowserStats());
});

// POST /reset - Reset server state (for debugging)
app.post('/reset', (req, res) => {
  console.log('🔄 Server state reset');
  syncState = {
    leaderId: null,
    leaderHeartbeat: 0,
    currentIndex: 0,
    rotateInterval: 7,
    fetchInterval: 120,
    colLInterval: 10,
    selectedFilters: ['Comfortable'],
    filteredData: [],
    alertSettings: {}
  };
  connectedBrowsers = {};
  res.json({ success: true, message: 'State reset' });
});

// Root endpoint - server info
app.get('/', (req, res) => {
  const browserStats = getBrowserStats();
  res.json({
    name: 'TradingView Sync Server',
    version: '2.2.0',
    endpoints: [
      'GET /health',
      'GET /sync-state',
      'POST /sync-state',
      'POST /claim-leader',
      'POST /heartbeat',
      'GET /browsers',
      'POST /reset'
    ],
    currentLeader: syncState.leaderId ? syncState.leaderId.slice(-8) : 'none',
    lastHeartbeat: syncState.leaderHeartbeat,
    ...browserStats
  });
});

// ===========================
// START SERVER
// ===========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ TradingView Sync Server v2.2 running on port ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
  console.log(`🔄 Sync State: http://localhost:${PORT}/sync-state`);
  console.log(`👥 Browsers: http://localhost:${PORT}/browsers`);
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});
